import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createAppModule } from "../apps/api/src/app.module.ts";
import { createApiApplication } from "../apps/api/src/bootstrap.ts";
import { CkbClient } from "../apps/api/src/ckb-client.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";
import {
  buildRecurringCreation,
  deploymentRegistry,
  parseHash32,
} from "../packages/core/src/index.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const { scriptToHash } = requireFromApi("@nervosnetwork/ckb-sdk-utils");
const { NestFactory } = await import(pathToFileURL(requireFromApi.resolve("@nestjs/core")).href);
const { FastifyAdapter } = await import(
  pathToFileURL(requireFromApi.resolve("@nestjs/platform-fastify")).href
);
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) {
  throw new Error("DATABASE_URL is required for transaction endpoint verification");
}

const databaseName = `automata_transactions_${randomBytes(6).toString("hex")}`;
if (!/^automata_transactions_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error("Refusing to manage an unexpected database name");
}
const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const testUrl = new URL(adminConnectionString);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
let app;
let inspect;

const [genesisHash] = deploymentRegistry.genesisHashes;
assert.ok(genesisHash);
const loaded = await deploymentRegistry.load(genesisHash);
assert.equal(loaded.status, "ok");
if (loaded.status !== "ok") process.exit(1);
const deployment = loaded.deployment;
const ownerLock = {
  codeHash: deployment.manifest.secp256k1Blake160.codeHash,
  hashType: deployment.manifest.secp256k1Blake160.hashType,
  args: deployment.manifest.fixtureWallet.lockArg,
};
const ownerLockHash = parseHash32(scriptToHash(ownerLock));
const creationRequest = {
  ownerLockHash,
  recipientLockHash: ownerLockHash,
  lockResolutions: [ownerLock],
  amount: "10000000000",
  intervalBlocks: "10",
  firstNotBefore: "500",
  totalRuns: "3",
  reward: "10000000000",
  creatorNonce: "71",
};
const creation = buildRecurringCreation({
  deployment,
  ...creationRequest,
  creationFee: {
    transactionBytes: { minimum: "500", maximum: "800" },
    feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
  },
});
const hash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const sourceTxHash = hash(102);
const sourceBlockHash = hash(120);
let tip = { number: 450n, hash: hash(130) };
let dryRuns = 0;
const chain = {
  async getTipHeader() {
    return tip;
  },
  async getTransactionStatus(txHash) {
    if (txHash !== sourceTxHash) return undefined;
    return {
      status: "committed",
      blockHash: sourceBlockHash,
      transaction: creation.transaction,
    };
  },
  async dryRun() {
    dryRuns += 1;
    return 777n;
  },
};

function environment() {
  return {
    AUTOMATA_PROFILE: "local",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: genesisHash,
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: testUrl.href,
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

const quietLogger = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await migrateDatabase({ connectionString: testUrl.href });
  inspect = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  await inspect`
    INSERT INTO networks (
      id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
    ) VALUES ('ckb_dev', ${genesisHash}, 'local', 2, ${deployment.manifestSha256})
  `;
  await inspect`
    INSERT INTO indexer_checkpoints (network_id, block_number, block_hash)
    VALUES ('ckb_dev', 130, ${hash(130)})
  `;
  await inspect`
    INSERT INTO jobs (
      network_id, job_id, outpoint_tx_hash, outpoint_index, sequence, owner_lock_hash,
      policy_script_hash, policy_kind, state, capacity, data, block_number, block_hash,
      transaction_index
    ) VALUES (
      'ckb_dev', ${creation.jobId}, ${sourceTxHash}, 0, 0, ${ownerLockHash},
      ${creation.intent.policyScriptHash}, 'recurring', 'live',
      ${BigInt(creation.transaction.outputs[0].capacity).toString()},
      ${Buffer.from(creation.jobData.slice(2), "hex")}, 120, ${sourceBlockHash}, 0
    )
  `;

  const result = await createApiApplication(environment(), {
    logger: quietLogger,
    createApplication: async (logger, config) => {
      const applicationModule = createAppModule(config.environment);
      const providers = applicationModule.providers.map((provider) =>
        provider && typeof provider === "object" && provider.provide === CkbClient
          ? { provide: CkbClient, useValue: chain }
          : provider,
      );
      return NestFactory.create({ ...applicationModule, providers }, new FastifyAdapter(), {
        abortOnError: true,
        bufferLogs: true,
        logger,
      });
    },
  });
  app = result.app;
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  const request = async (method, url, payload) => {
    const response = await fastify.inject({ method, url, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: response.json() };
  };

  const quote = await request("GET", `/v1/jobs/${creation.jobId}/quote`);
  assert.equal(quote.status, 200);
  const ownerRequest = {
    jobId: creation.jobId,
    quoteId: quote.body.quoteId,
    ownerLock,
  };
  const cancel = await request("POST", "/v1/transactions/cancel-job", ownerRequest);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.intent.action, "cancel");
  assert.equal(cancel.body.transaction.inputs[0].previousOutput.txHash, sourceTxHash);

  const recovery = await request("POST", "/v1/transactions/recover-job", {
    ...ownerRequest,
    reason: "terminal_operational_failure",
  });
  assert.equal(recovery.status, 200);
  assert.equal(recovery.body.intent.paysExecutorReward, false);

  const topUp = await request("POST", "/v1/transactions/top-up-job", {
    ...ownerRequest,
    rewardIncrease: "0",
    budgetIncrease: "10000000000",
    capacityIncrease: "10000000000",
  });
  assert.equal(topUp.status, 200);
  assert.equal(topUp.body.intent.diff.classification, "top_up");

  const completedCancellation = {
    ...cancel.body.transaction,
    inputs: [
      ...cancel.body.transaction.inputs,
      { since: "0x0", previousOutput: { txHash: hash(200), index: "0x0" } },
    ],
    witnesses: [...cancel.body.transaction.witnesses, "0x"],
  };
  const validated = await request("POST", "/v1/transactions/validate-signed", {
    operation: "cancel_job",
    request: ownerRequest,
    intentHash: cancel.body.intentHash,
    policyCriticalHash: cancel.body.policyCriticalHash,
    transaction: completedCancellation,
  });
  assert.equal(validated.status, 200);
  assert.equal(validated.body.dryRunCycles, "777");
  assert.equal(dryRuns, 1);

  const deadlineFixture = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile(new URL("../contracts/fixtures/deadline_creation_v1.json", import.meta.url), "utf8"),
  );
  const successLock = { ...ownerLock, args: "0x1234" };
  const deadline = await request("POST", "/v1/transactions/create-deadline-job", {
    pledges: deadlineFixture.pledges.map((pledge) => ({
      outPoint: { txHash: pledge.tx_hash, index: pledge.index },
      refundLockHash: ownerLockHash,
      amount: pledge.amount,
    })),
    target: deadlineFixture.target,
    deadlineBlock: deadlineFixture.deadline_block,
    successLockHash: parseHash32(scriptToHash(successLock)),
    cancelLockHash: ownerLockHash,
    reward: deadlineFixture.reward,
    creatorNonce: deadlineFixture.creator_nonce,
    lockResolutions: [ownerLock, successLock],
  });
  assert.equal(deadline.status, 200);
  assert.match(deadline.body.protocolIntentHash, /^0x[0-9a-f]{64}$/);

  const recurring = await request("POST", "/v1/transactions/create-recurring-job", creationRequest);
  assert.equal(recurring.status, 200);
  assert.equal(recurring.body.protocolIntentHash, creation.intentHash);

  tip = { number: 451n, hash: hash(131) };
  const stale = await request("POST", "/v1/transactions/cancel-job", ownerRequest);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STALE_QUOTE");

  console.log(
    "Transaction endpoints verified: create, cancel, recover, top-up, intent binding, and dry-run dispatch",
  );
} finally {
  await app?.close();
  await inspect?.end({ timeout: 2 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
