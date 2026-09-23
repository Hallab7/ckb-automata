/* global fetch */

import assert from "node:assert/strict";

import { createApiApplication } from "../apps/api/src/bootstrap.ts";
import { deploymentRegistry, parseHash32 } from "../packages/core/src/index.ts";
import { occupiedShannons, scriptHash, signSingleInput } from "./lib/ckb-local.mjs";

const rpcUrl = process.env.CKB_RPC_URL ?? "http://127.0.0.1:58114";
let rpcId = 0;

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: ++rpcId, jsonrpc: "2.0", method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(`${method}: ${payload.error?.message ?? `HTTP ${response.status}`}`);
  }
  return payload.result;
}

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
const ownerLockHash = parseHash32(scriptHash(ownerLock));
const tip = await rpc("get_tip_header");

async function findFundingCell() {
  for (let height = BigInt(tip.number); height >= 0n; height -= 1n) {
    const block = await rpc("get_block_by_number", [`0x${height.toString(16)}`]);
    for (const transaction of block?.transactions ?? []) {
      for (const [index, output] of transaction.outputs.entries()) {
        if (
          output.lock.code_hash !== ownerLock.codeHash ||
          output.lock.hash_type !== ownerLock.hashType ||
          output.lock.args !== ownerLock.args ||
          output.type !== null
        ) {
          continue;
        }
        const outPoint = { tx_hash: transaction.hash, index: `0x${index.toString(16)}` };
        const candidate = await rpc("get_live_cell", [outPoint, false]);
        if (candidate.status === "live") {
          return {
            outPoint: { txHash: transaction.hash, index: outPoint.index },
            live: candidate,
          };
        }
      }
    }
  }
  throw new Error("no live fixture-wallet funding cell was found");
}

const funding = await findFundingCell();
const fundingOutPoint = funding.outPoint;
const live = funding.live;
const request = {
  ownerLockHash,
  recipientLockHash: ownerLockHash,
  amount: "10000000000",
  intervalBlocks: "10",
  firstNotBefore: (BigInt(tip.number) + 20n).toString(),
  totalRuns: "2",
  reward: "10000000000",
  creatorNonce: "66",
};

const quietLogger = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};
const result = await createApiApplication(
  {
    AUTOMATA_PROFILE: "local",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: genesisHash,
    CKB_RPC_URL: rpcUrl,
    CKB_INDEXER_URL: rpcUrl,
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55442/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  },
  { logger: quietLogger },
);

try {
  await result.app.init();
  const fastify = result.app.getHttpAdapter().getInstance();
  const post = async (url, payload) => {
    const response = await fastify.inject({ method: "POST", url, payload });
    return { status: response.statusCode, body: response.json() };
  };
  const built = await post("/v1/transactions/create-recurring-job", request);
  assert.equal(built.status, 200);
  assert.equal(built.body.operation, "create_recurring_job");
  assert.match(built.body.intentHash, /^[0-9a-f]{64}$/);
  assert.notEqual(built.body.intentHash, built.body.policyCriticalHash);
  assert.match(built.body.protocolIntentHash, /^0x[0-9a-f]{64}$/);
  assert.equal(built.body.signingEntries[0].role, "funding");

  const inputCapacity = BigInt(live.cell.output.capacity);
  const lockedCapacity = BigInt(built.body.transaction.outputs[0].capacity);
  const transactionFee = 1_000_000n;
  const changeCapacity = inputCapacity - lockedCapacity - transactionFee;
  assert.ok(
    changeCapacity >= occupiedShannons({ capacity: "0x0", lock: ownerLock, type: null }, "0x"),
  );
  const completed = {
    ...built.body.transaction,
    inputs: [
      {
        since: "0x0",
        previousOutput: fundingOutPoint,
      },
    ],
    outputs: [
      ...built.body.transaction.outputs,
      { capacity: `0x${changeCapacity.toString(16)}`, lock: ownerLock, type: null },
    ],
    outputsData: [...built.body.transaction.outputsData, "0x"],
  };
  const signed = signSingleInput(completed, {
    lock: "",
    inputType: "",
    outputType: built.body.intent.recurringPayload,
  });
  const validationRequest = {
    operation: "create_recurring_job",
    request,
    intentHash: built.body.intentHash,
    policyCriticalHash: built.body.policyCriticalHash,
    transaction: signed,
  };
  const validation = await post("/v1/transactions/validate-signed", validationRequest);
  assert.equal(validation.status, 200);
  assert.equal(validation.body.valid, true);
  assert.ok(BigInt(validation.body.dryRunCycles) > 0n);
  assert.equal(validation.body.intentHash, built.body.intentHash);

  const stale = await post("/v1/transactions/validate-signed", {
    ...validationRequest,
    intentHash: "0".repeat(64),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STALE_TRANSACTION_INTENT");

  const stalePolicy = await post("/v1/transactions/validate-signed", {
    ...validationRequest,
    policyCriticalHash: "0".repeat(64),
  });
  assert.equal(stalePolicy.status, 409);
  assert.equal(stalePolicy.body.code, "STALE_POLICY_CONTEXT");

  const tampered = await post("/v1/transactions/validate-signed", {
    ...validationRequest,
    transaction: {
      ...signed,
      outputs: [
        { ...signed.outputs[0], capacity: `0x${(lockedCapacity - 1n).toString(16)}` },
        ...signed.outputs.slice(1),
      ],
    },
  });
  assert.equal(tampered.status, 400);
  assert.equal(tampered.body.code, "SIGNED_TRANSACTION_MISMATCH");

  console.log(
    `Transaction API verified: reviewed intent ${built.body.intentHash}, dry run ${validation.body.dryRunCycles} cycles`,
  );
} finally {
  await result.app.close();
}
