/* global fetch */

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { JobDataV1 } from "../packages/molecule/src/index.ts";
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
import {
  occupiedShannons,
  scriptHash,
  signSingleInput,
  toRpcTransaction,
} from "./lib/ckb-local.mjs";

const rpcUrl = process.env.CKB_RPC_URL ?? "http://127.0.0.1:58114";
const minerContainer = process.env.CKB_MINER_CONTAINER;
const initialFundingTxHash = process.env.RECURRING_EXECUTOR_FUNDING_TX_HASH;
const initialFundingIndex = process.env.RECURRING_EXECUTOR_FUNDING_INDEX ?? "0x1";
const transactionFee = 1_000_000n;
let rpcId = 0;

if (!minerContainer) {
  throw new Error("CKB_MINER_CONTAINER is required for the stateful recurring executor proof");
}

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

function mineBlocks(count = 20) {
  execFileSync(
    "docker",
    ["exec", minerContainer, "ckb", "miner", "-C", "/var/lib/ckb", "--limit", String(count)],
    { stdio: "ignore" },
  );
}

async function commit(transaction) {
  const txHash = await rpc("send_transaction", [toRpcTransaction(transaction)]);
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

async function assertSpent(outPoint, label) {
  const cell = await rpc("get_live_cell", [
    { tx_hash: outPoint.txHash, index: `0x${outPoint.index.toString(16)}` },
    false,
  ]);
  assert.notEqual(cell.status, "live", `${label} must be consumed`);
}

const [genesisHash] = deploymentRegistry.genesisHashes;
assert.ok(genesisHash, "the deployment registry must contain the local network");
const loaded = await deploymentRegistry.load(genesisHash);
assert.equal(loaded.status, "ok", "the local deployment manifest must pass integrity checks");
if (loaded.status !== "ok") process.exit(1);
const deployment = loaded.deployment;
let fundingOutPoint = parseOutPoint({
  txHash: initialFundingTxHash ?? deployment.confirmation.verificationTransactionHash,
  index: initialFundingIndex,
});
const funding = await rpc("get_live_cell", [
  { tx_hash: fundingOutPoint.txHash, index: `0x${fundingOutPoint.index.toString(16)}` },
  false,
]);
assert.equal(funding.status, "live", "select a live disposable-chain funding outpoint");
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
  totalRuns: "4",
  reward: "10000000000",
  creatorNonce: "5101",
  creationFee: {
    transactionBytes: { minimum: "500", maximum: "900" },
    feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
  },
});
const locked = BigInt(creation.transaction.outputs[0].capacity);
const ownerChange = fundingCapacity - locked - transactionFee;
assert.ok(
  ownerChange >= occupiedShannons({ capacity: "0x0", lock: ownerLock, type: null }, "0x"),
  "recurring creation must retain a valid executor fee cell",
);
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
    { capacity: `0x${ownerChange.toString(16)}`, lock: ownerLock, type: null },
  ],
  outputsData: [...creation.transaction.outputsData, "0x"],
};
const signedCreation = signSingleInput(completedCreation, {
  lock: "",
  inputType: "",
  outputType: creation.completion.requiredOutputType,
});
assertRecurringCompletion(creation, signedCreation);
const creationResult = await commit(signedCreation);
const creationHash = parseHash32(creationResult.transaction.hash);
let jobOutPoint = parseOutPoint({ txHash: creationHash, index: "0" });
let feeOutPoint = parseOutPoint({ txHash: creationHash, index: "1" });
let jobOutput = creation.transaction.outputs[0];
let jobData = creation.jobData;
let feeCapacity = ownerChange;
let jobHeader = await snapshotHeader(creationResult.tx_status.block_hash);
const registry = new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]);
const labels = ["first", "middle", "late", "final"];

for (let sequence = 0; sequence < labels.length; sequence += 1) {
  if (sequence === 2) mineBlocks(7);
  const currentTip = await rpc("get_tip_header");
  const snapshot = Object.freeze({
    deployment,
    tip: Object.freeze({
      hash: parseHash32(currentTip.hash),
      number: parseBlockNumber(currentTip.number),
      epoch: currentTip.epoch,
      timestamp: currentTip.timestamp,
    }),
    job: Object.freeze({
      outPoint: jobOutPoint,
      output: jobOutput,
      data: jobData,
      blockHash: jobHeader.hash,
      blockNumber: jobHeader.number,
    }),
    applicationCells: Object.freeze([]),
    feeCells: Object.freeze([
      Object.freeze({
        outPoint: feeOutPoint,
        output: Object.freeze({
          capacity: `0x${feeCapacity.toString(16)}`,
          lock: ownerLock,
          type: null,
        }),
        data: "0x",
        blockHash: jobHeader.hash,
        blockNumber: jobHeader.number,
      }),
    ]),
    headers: Object.freeze([jobHeader]),
    resolvedLocks: Object.freeze([ownerLock, recipientLock]),
    payloads: Object.freeze([creation.recurringPayload]),
    claims: Object.freeze({}),
  });
  const execution = runExecutorAdapter(registry, snapshot, {
    rewardLock: ownerLock,
    transactionFee: parseShannons(transactionFee),
  });
  assert.equal(execution.status, "built", `${labels[sequence]} run must be eligible and verified`);
  if (execution.status !== "built") throw new Error(`${labels[sequence]} run did not build`);
  assert.equal(execution.build.summary.sequence, String(sequence));
  assert.equal(execution.build.summary.final, sequence === labels.length - 1);
  if (sequence === 2) {
    const successor = JobDataV1.unpack(
      Buffer.from(execution.build.transaction.outputsData[2].slice(2), "hex"),
    );
    assert.equal(BigInt(successor.not_before.toString()), firstNotBefore + 60n);
    assert.ok(
      BigInt(currentTip.number) > firstNotBefore + 40n,
      "late proof must execute after its bound",
    );
  }
  const signedExecution = signSingleInput(
    execution.build.transaction,
    { lock: "", inputType: "", outputType: "" },
    undefined,
    1,
  );
  const dryRun = await rpc("dry_run_transaction", [toRpcTransaction(signedExecution)]);
  assert.ok(BigInt(dryRun.cycles) > 0n, `${labels[sequence]} run must execute contract cycles`);
  const result = await commit(signedExecution);
  const transactionHash = parseHash32(result.transaction.hash);
  await assertSpent(jobOutPoint, `${labels[sequence]} job input`);
  if (sequence < labels.length - 1) {
    jobOutPoint = parseOutPoint({ txHash: transactionHash, index: "2" });
    jobOutput = execution.build.transaction.outputs[2];
    jobData = execution.build.transaction.outputsData[2];
    jobHeader = await snapshotHeader(result.tx_status.block_hash);
  } else {
    const ownerResidual = await rpc("get_live_cell", [
      { tx_hash: transactionHash, index: "0x2" },
      false,
    ]);
    assert.equal(ownerResidual.status, "live", "final run must leave the owner residual live");
  }
  feeOutPoint = parseOutPoint({ txHash: transactionHash, index: "3" });
  feeCapacity = BigInt(execution.build.transaction.outputs[3].capacity);
  console.log(
    `recurring ${labels[sequence]} committed ${transactionHash} after ${dryRun.cycles} dry-run cycles`,
  );
}
