import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createAppModule } from "../apps/api/src/app.module.ts";
import { createApiApplication } from "../apps/api/src/bootstrap.ts";
import { CkbClient } from "../apps/api/src/ckb-client.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";
import { JobQuoteService } from "../apps/api/src/quotes.ts";
import {
  buildDeadlineCreation,
  buildRecurringCreation,
  calculateDeadlineQuote,
  calculateRecurringQuote,
  deploymentRegistry,
  parseHash32,
  parseOutPoint,
} from "../packages/core/src/index.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const { NestFactory } = await import(pathToFileURL(requireFromApi.resolve("@nestjs/core")).href);
const { FastifyAdapter } = await import(
  pathToFileURL(requireFromApi.resolve("@nestjs/platform-fastify")).href
);
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for quote verification");

const databaseName = `automata_job_quotes_${randomBytes(6).toString("hex")}`;
if (!/^automata_job_quotes_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error("Refusing to manage an unexpected database name");
}
const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const testUrl = new URL(adminConnectionString);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
let app;
let inspect;

const recurringFixture = JSON.parse(
  await readFile(
    new URL("../contracts/fixtures/recurring_creation_v1.json", import.meta.url),
    "utf8",
  ),
);
const deadlineFixture = JSON.parse(
  await readFile(
    new URL("../contracts/fixtures/deadline_creation_v1.json", import.meta.url),
    "utf8",
  ),
);
const [genesisHash] = deploymentRegistry.genesisHashes;
assert.ok(genesisHash);
const loaded = await deploymentRegistry.load(genesisHash);
assert.equal(loaded.status, "ok");
if (loaded.status !== "ok") throw new Error("local deployment fixture is unavailable");

const recurringBuild = buildRecurringCreation({
  deployment: loaded.deployment,
  ownerLockHash: parseHash32(recurringFixture.owner_lock_hash),
  recipientLockHash: parseHash32(recurringFixture.recipient_lock_hash),
  amount: recurringFixture.amount,
  intervalBlocks: recurringFixture.interval_blocks,
  firstNotBefore: recurringFixture.first_not_before,
  totalRuns: recurringFixture.total_runs,
  reward: recurringFixture.reward,
  creatorNonce: recurringFixture.creator_nonce,
  creationFee: {
    transactionBytes: recurringFixture.creation_fee.transaction_bytes,
    feeRatePerKilobyte: recurringFixture.creation_fee.fee_rate_per_kilobyte,
  },
});
const deadlineBuild = buildDeadlineCreation({
  deployment: loaded.deployment,
  pledges: deadlineFixture.pledges.map((pledge) => ({
    outPoint: parseOutPoint({ txHash: pledge.tx_hash, index: pledge.index }),
    refundLockHash: parseHash32(pledge.refund_lock_hash),
    amount: pledge.amount,
  })),
  target: deadlineFixture.target,
  deadlineBlock: deadlineFixture.deadline_block,
  successLockHash: parseHash32(deadlineFixture.success_lock_hash),
  cancelLockHash: parseHash32(deadlineFixture.cancel_lock_hash),
  reward: deadlineFixture.reward,
  creatorNonce: deadlineFixture.creator_nonce,
  creationFee: {
    transactionBytes: deadlineFixture.creation_fee.transaction_bytes,
    feeRatePerKilobyte: deadlineFixture.creation_fee.fee_rate_per_kilobyte,
  },
});

const hash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const recurringCreationHash = hash(101);
const recurringTopUpHash = hash(102);
const deadlineCreationHash = hash(103);
const recurringBlockHash = hash(120);
const deadlineBlockHash = hash(121);
let tip = { number: 450n, hash: hash(130) };
const requestedTransactions = [];

const recurringCurrentTransaction = {
  ...recurringBuild.transaction,
  inputs: [{ since: "0x0", previousOutput: { txHash: recurringCreationHash, index: "0x0" } }],
  witnesses: ["0x"],
};
const transactions = new Map([
  [
    recurringTopUpHash,
    {
      status: "committed",
      blockHash: recurringBlockHash,
      transaction: recurringCurrentTransaction,
    },
  ],
  [
    recurringCreationHash,
    { status: "committed", blockHash: hash(110), transaction: recurringBuild.transaction },
  ],
  [
    deadlineCreationHash,
    {
      status: "committed",
      blockHash: deadlineBlockHash,
      transaction: deadlineBuild.transaction,
    },
  ],
]);
const chain = {
  async getTipHeader() {
    return tip;
  },
  async getTransactionStatus(txHash) {
    requestedTransactions.push(txHash);
    return transactions.get(txHash);
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
  };
}

const quietLogger = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

function expectedAmounts(quote) {
  return {
    occupiedCapacity: {
      jobCell: quote.occupiedCapacity.jobCell.toString(),
      applicationCell: quote.occupiedCapacity.applicationCell.toString(),
      total: quote.occupiedCapacity.total.toString(),
    },
    payout: {
      perExecution: quote.applicationAmount.perExecution.toString(),
      total: quote.applicationAmount.total.toString(),
    },
    rewards: {
      perExecution: quote.rewards.perExecution.toString(),
      total: quote.rewards.total.toString(),
    },
    remainingBudget: quote.remainingBudget.toString(),
    residualRefund: quote.residualRefund.toString(),
    retainedTerminalCapacity: quote.retainedTerminalCapacity.toString(),
    currentLockedTotal: quote.maximumLockedTotal.toString(),
    estimatedFee: {
      minimum: quote.estimatedFee.minimum.toString(),
      maximum: quote.estimatedFee.maximum.toString(),
    },
  };
}

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await migrateDatabase({ connectionString: testUrl.href });
  inspect = postgres(testUrl.href, { max: 1, onnotice: () => undefined });

  await inspect`
    INSERT INTO networks (
      id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
    ) VALUES ('ckb_dev', ${genesisHash}, 'local', 2, ${loaded.deployment.manifestSha256})
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
      'ckb_dev', ${recurringBuild.jobId}, ${recurringTopUpHash}, 0, 0,
      ${recurringFixture.owner_lock_hash}, ${recurringBuild.intent.policyScriptHash},
      'recurring', 'live', ${BigInt(recurringBuild.transaction.outputs[0].capacity).toString()},
      ${Buffer.from(recurringBuild.jobData.slice(2), "hex")}, 120, ${recurringBlockHash}, 0
    ), (
      'ckb_dev', ${deadlineBuild.jobId}, ${deadlineCreationHash}, 1, 0,
      ${deadlineFixture.cancel_lock_hash}, ${deadlineBuild.intent.policyScriptHash},
      'deadline', 'live', ${BigInt(deadlineBuild.transaction.outputs[1].capacity).toString()},
      ${Buffer.from(deadlineBuild.jobData.slice(2), "hex")}, 121, ${deadlineBlockHash}, 0
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
  const getQuote = async (jobId) => {
    const response = await fastify.inject({ method: "GET", url: `/v1/jobs/${jobId}/quote` });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const service = app.get(JobQuoteService);
  const recurring = await getQuote(recurringBuild.jobId);
  const recurringSdk = calculateRecurringQuote({
    amountPerExecution: recurringFixture.amount,
    rewardPerExecution: recurringFixture.reward,
    executions: recurringFixture.total_runs,
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "800" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  assert.deepEqual(recurring.amounts, expectedAmounts(recurringSdk));
  assert.deepEqual(requestedTransactions, [recurringTopUpHash, recurringCreationHash]);
  assert.equal(recurring.schedule.blocksUntilEligible, "50");
  assert.equal(recurring.schedule.approximateSecondsUntilEligible, "500");
  assert.equal(recurring.snapshot.indexCheckpoint.blockNumber, "130");

  requestedTransactions.length = 0;
  const deadline = await getQuote(deadlineBuild.jobId);
  const deadlineSdk = calculateDeadlineQuote({
    pledgedAmount: deadlineFixture.pledges.reduce((sum, pledge) => sum + BigInt(pledge.amount), 0n),
    reward: deadlineFixture.reward,
    creationFee: {
      transactionBytes: { minimum: "700", maximum: "900" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  assert.deepEqual(deadline.amounts, expectedAmounts(deadlineSdk));
  assert.deepEqual(requestedTransactions, [deadlineCreationHash]);
  assert.equal(deadline.expiry.condition, "tip_or_job_snapshot_change");

  await service.assertFresh(recurringBuild.jobId, recurring.quoteId);
  tip = { number: 451n, hash: hash(131) };
  await assert.rejects(service.assertFresh(recurringBuild.jobId, recurring.quoteId), (error) => {
    assert.equal(error.getResponse().code, "STALE_QUOTE");
    return true;
  });

  tip = { number: 450n, hash: hash(130) };
  const committedRecurring = transactions.get(recurringTopUpHash);
  transactions.set(recurringTopUpHash, {
    ...committedRecurring,
    transaction: {
      ...committedRecurring.transaction,
      outputs: [
        {
          ...committedRecurring.transaction.outputs[0],
          capacity: `0x${(BigInt(committedRecurring.transaction.outputs[0].capacity) + 1n).toString(16)}`,
        },
      ],
    },
  });
  await assert.rejects(service.quote(recurringBuild.jobId), (error) => {
    assert.equal(error.getResponse().code, "QUOTE_EVIDENCE_UNAVAILABLE");
    return true;
  });
  transactions.set(recurringTopUpHash, committedRecurring);

  tip = { number: 129n, hash: hash(129) };
  await assert.rejects(service.quote(deadlineBuild.jobId), (error) => {
    assert.equal(error.getResponse().code, "QUOTE_EVIDENCE_UNAVAILABLE");
    return true;
  });

  console.log(
    "Job quotes verified: SDK parity, ancestry, snapshots, mismatch guards, and stale rejection",
  );
} finally {
  await app?.close();
  await inspect?.end({ timeout: 2 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
