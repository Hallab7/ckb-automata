/* global fetch */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import {
  assertRecurringCompletion,
  buildRecurringCreation,
  deploymentRegistry,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseShannons,
} from "../packages/core/src/index.ts";
import {
  ExecutorAdapterRegistry,
  RECURRING_EXECUTOR_ADAPTER,
  runExecutorAdapter,
} from "../apps/executor/src/index.ts";
import { executorLockHashFromWitness } from "../apps/api/src/indexer/job-transitions.ts";
import {
  occupiedShannons,
  scriptHash,
  signSingleInput,
  toRpcTransaction,
  transactionHash,
} from "./lib/ckb-local.mjs";

const rpcUrl = process.env.CKB_RPC_URL ?? "http://127.0.0.1:58114";
const minerContainer = process.env.CKB_MINER_CONTAINER;
const transactionFee = 1_000_000n;
let rpcId = 0;

if (!minerContainer) {
  throw new Error("CKB_MINER_CONTAINER is required for the stateful contention proof");
}

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: ++rpcId, jsonrpc: "2.0", method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const error = new Error(`${method}: ${payload.error?.message ?? `HTTP ${response.status}`}`);
    error.code = payload.error?.code;
    throw error;
  }
  return payload.result;
}

function mineBlocks(count = 20) {
  execFileSync(
    "docker",
    ["exec", minerContainer, "ckb", "miner", "-C", "/var/lib/ckb", "--limit", String(count)],
    { stdio: "ignore" },
  );
}

async function commit(transaction) {
  const txHash = parseHash32(await rpc("send_transaction", [toRpcTransaction(transaction)]));
  mineBlocks();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await rpc("get_transaction", [txHash]);
    if (result?.tx_status?.status === "committed") return result;
    if (result?.tx_status?.status === "rejected") {
      throw new Error(`${txHash} was rejected: ${result.tx_status.reason}`);
    }
    await delay(250);
  }
  throw new Error(`${txHash} was not committed after mining`);
}

function fromRpcScript(value) {
  return { codeHash: value.code_hash, hashType: value.hash_type, args: value.args };
}

async function snapshotHeader(blockHash) {
  const value = await rpc("get_header", [blockHash]);
  return Object.freeze({
    hash: parseHash32(value.hash),
    number: parseBlockNumber(value.number),
    epoch: value.epoch,
    timestamp: value.timestamp,
  });
}

async function submit(transaction) {
  const expectedHash = parseHash32(transactionHash(transaction));
  try {
    const returnedHash = parseHash32(
      await rpc("send_transaction", [toRpcTransaction(transaction)]),
    );
    assert.equal(returnedHash, expectedHash);
    return { accepted: true, transactionHash: expectedHash };
  } catch (error) {
    return { accepted: false, transactionHash: expectedHash, error };
  }
}

const [genesisHash] = deploymentRegistry.genesisHashes;
assert.ok(genesisHash, "the deployment registry must contain the local network");
const loaded = await deploymentRegistry.load(genesisHash);
assert.equal(loaded.status, "ok", "the local deployment manifest must pass integrity checks");
if (loaded.status !== "ok") process.exit(1);
const deployment = loaded.deployment;
const fundingOutPoint = parseOutPoint({
  txHash: deployment.confirmation.verificationTransactionHash,
  index: "0x1",
});
const funding = await rpc("get_live_cell", [
  { tx_hash: fundingOutPoint.txHash, index: "0x1" },
  false,
]);
assert.equal(funding.status, "live", "the disposable chain must expose its funding output");
const ownerLock = fromRpcScript(funding.cell.output.lock);
const ownerLockHash = parseHash32(scriptHash(ownerLock));
const recipientLock = Object.freeze({ ...ownerLock, args: `0x${"22".repeat(20)}` });
const recipientLockHash = parseHash32(scriptHash(recipientLock));
const fundingCapacity = BigInt(funding.cell.output.capacity);

const initialTip = await rpc("get_tip_header");
const firstNotBefore = BigInt(initialTip.number) + 20n;
const creation = buildRecurringCreation({
  deployment,
  ownerLockHash,
  recipientLockHash,
  amount: "10000000000",
  intervalBlocks: "20",
  firstNotBefore,
  totalRuns: "2",
  reward: "10000000000",
  creatorNonce: "7701",
  creationFee: {
    transactionBytes: { minimum: "500", maximum: "900" },
    feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
  },
});
const locked = BigInt(creation.transaction.outputs[0].capacity);
const available = fundingCapacity - locked - transactionFee;
const firstFeeCapacity = available / 2n;
const secondFeeCapacity = available - firstFeeCapacity;
const minimumPlainCell = occupiedShannons({ capacity: "0x0", lock: ownerLock, type: null }, "0x");
assert.ok(firstFeeCapacity > minimumPlainCell && secondFeeCapacity > minimumPlainCell);
const completedCreation = {
  ...creation.transaction,
  inputs: [
    {
      since: "0x0",
      previousOutput: {
        txHash: fundingOutPoint.txHash,
        index: `0x${fundingOutPoint.index.toString(16)}`,
      },
    },
  ],
  outputs: [
    ...creation.transaction.outputs,
    { capacity: `0x${firstFeeCapacity.toString(16)}`, lock: ownerLock, type: null },
    { capacity: `0x${secondFeeCapacity.toString(16)}`, lock: ownerLock, type: null },
  ],
  outputsData: [...creation.transaction.outputsData, "0x", "0x"],
};
const signedCreation = signSingleInput(completedCreation, {
  lock: "",
  inputType: "",
  outputType: creation.completion.requiredOutputType,
});
assertRecurringCompletion(creation, signedCreation);
const creationResult = await commit(signedCreation);
const creationHash = parseHash32(creationResult.transaction.hash);
const jobHeader = await snapshotHeader(creationResult.tx_status.block_hash);
const currentTip = await rpc("get_tip_header");
const baseSnapshot = {
  deployment,
  tip: Object.freeze({
    hash: parseHash32(currentTip.hash),
    number: parseBlockNumber(currentTip.number),
    epoch: currentTip.epoch,
    timestamp: currentTip.timestamp,
  }),
  job: Object.freeze({
    outPoint: parseOutPoint({ txHash: creationHash, index: "0" }),
    output: creation.transaction.outputs[0],
    data: creation.jobData,
    blockHash: jobHeader.hash,
    blockNumber: jobHeader.number,
  }),
  applicationCells: Object.freeze([]),
  headers: Object.freeze([jobHeader]),
  resolvedLocks: Object.freeze([ownerLock, recipientLock]),
  payloads: Object.freeze([creation.recurringPayload]),
  claims: Object.freeze({}),
};
const feeCells = [firstFeeCapacity, secondFeeCapacity].map((capacity, index) =>
  Object.freeze({
    outPoint: parseOutPoint({ txHash: creationHash, index: (index + 1).toString() }),
    output: Object.freeze({ capacity: `0x${capacity.toString(16)}`, lock: ownerLock, type: null }),
    data: "0x",
    blockHash: jobHeader.hash,
    blockNumber: jobHeader.number,
  }),
);
const registry = new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]);
const identity = { rewardLock: ownerLock, transactionFee: parseShannons(transactionFee) };
const executions = feeCells.map((feeCell) =>
  runExecutorAdapter(registry, Object.freeze({ ...baseSnapshot, feeCells: [feeCell] }), identity),
);
assert.ok(executions.every((execution) => execution.status === "built"));
const transactions = executions.map((execution) => {
  assert.equal(execution.status, "built");
  return signSingleInput(
    execution.build.transaction,
    { lock: "", inputType: "", outputType: "" },
    undefined,
    1,
  );
});
const transactionHashes = transactions.map((transaction) =>
  parseHash32(transactionHash(transaction)),
);
assert.notEqual(transactionHashes[0], transactionHashes[1]);
for (const transaction of transactions) {
  const dryRun = await rpc("dry_run_transaction", [toRpcTransaction(transaction)]);
  assert.ok(BigInt(dryRun.cycles) > 0n);
}

const submissions = await Promise.all(transactions.map(submit));
assert.equal(submissions.filter((submission) => submission.accepted).length, 1);
mineBlocks();
const observations = await Promise.all(
  transactionHashes.map((hash) => rpc("get_transaction", [hash])),
);
const committed = observations
  .map((observation, index) => ({ observation, transactionHash: transactionHashes[index] }))
  .filter(({ observation }) => observation?.tx_status?.status === "committed");
assert.equal(committed.length, 1, "exactly one competing transaction must become canonical");
const winner = committed[0];
assert.ok(winner);
const winnerIndex = transactionHashes.indexOf(winner.transactionHash);
assert.notEqual(winnerIndex, -1);
assert.equal(
  executorLockHashFromWitness(transactions[winnerIndex].witnesses[0]),
  ownerLockHash,
  "the canonical witness must attribute the winning executor",
);
const consumed = await rpc("get_live_cell", [{ tx_hash: creationHash, index: "0x0" }, false]);
assert.notEqual(consumed.status, "live", "the raced job input must be consumed exactly once");

console.log(
  `contention winner ${winner.transactionHash}; loser ${transactionHashes[1 - winnerIndex]}; executor ${ownerLockHash}`,
);
