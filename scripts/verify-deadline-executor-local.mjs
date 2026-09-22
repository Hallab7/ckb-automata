/* global fetch */

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { CampaignDataV1 } from "../packages/molecule/src/index.ts";

import {
  assertDeadlineCompletion,
  buildDeadlineCreation,
  deploymentRegistry,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseShannons,
} from "../packages/core/src/index.ts";
import {
  DEADLINE_EXECUTOR_ADAPTER,
  ExecutorAdapterRegistry,
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
const initialFundingTxHash = process.env.DEADLINE_EXECUTOR_FUNDING_TX_HASH;
const initialFundingIndex = process.env.DEADLINE_EXECUTOR_FUNDING_INDEX ?? "0x1";
const transactionFee = 1_000_000n;
let rpcId = 0;

if (!minerContainer) {
  throw new Error("CKB_MINER_CONTAINER is required for the stateful deadline executor proof");
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
  return {
    codeHash: value.code_hash,
    hashType: value.hash_type,
    args: value.args,
  };
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
let funding = await rpc("get_live_cell", [
  { tx_hash: fundingOutPoint.txHash, index: `0x${fundingOutPoint.index.toString(16)}` },
  false,
]);
assert.equal(funding.status, "live", "select a live disposable-chain funding outpoint");
const ownerLock = fromRpcScript(funding.cell.output.lock);
const ownerLockHash = parseHash32(scriptHash(ownerLock));
const successLock = Object.freeze({ ...ownerLock, args: `0x${"22".repeat(20)}` });
const successLockHash = parseHash32(scriptHash(successLock));
let fundingCapacity = BigInt(funding.cell.output.capacity);
const registry = new ExecutorAdapterRegistry([DEADLINE_EXECUTOR_ADAPTER]);

async function executeFixture(label, target, expectedOutcome, nonce) {
  const tip = await rpc("get_tip_header");
  const deadline = BigInt(tip.number) + 5n;
  const creation = buildDeadlineCreation({
    deployment,
    pledges: [
      {
        outPoint: fundingOutPoint,
        refundLockHash: ownerLockHash,
        amount: "10000000000",
      },
    ],
    target,
    deadlineBlock: deadline,
    successLockHash,
    cancelLockHash: ownerLockHash,
    reward: "10000000000",
    creatorNonce: nonce,
    creationFee: {
      transactionBytes: { minimum: "700", maximum: "1200" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const locked = creation.transaction.outputs.reduce(
    (total, output) => total + BigInt(output.capacity),
    0n,
  );
  const ownerChange = fundingCapacity - locked - transactionFee;
  assert.ok(
    ownerChange >= occupiedShannons({ capacity: "0x0", lock: ownerLock, type: null }, "0x"),
    `${label} creation must retain a valid executor fee cell`,
  );
  const completedCreation = {
    ...creation.transaction,
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
  assertDeadlineCompletion(creation, signedCreation);
  const creationResult = await commit(signedCreation);
  const creationHash = parseHash32(creationResult.transaction.hash);
  const creationHeader = await snapshotHeader(creationResult.tx_status.block_hash);
  const currentTip = await rpc("get_tip_header");
  const jobOutPoint = parseOutPoint({ txHash: creationHash, index: "0x1" });
  const campaignOutPoint = parseOutPoint({ txHash: creationHash, index: "0x0" });
  const feeOutPoint = parseOutPoint({ txHash: creationHash, index: "0x2" });
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
      output: creation.transaction.outputs[1],
      data: creation.jobData,
      blockHash: creationHeader.hash,
      blockNumber: creationHeader.number,
    }),
    applicationCells: Object.freeze([
      Object.freeze({
        outPoint: campaignOutPoint,
        output: creation.transaction.outputs[0],
        data: creation.campaignData,
        blockHash: creationHeader.hash,
        blockNumber: creationHeader.number,
      }),
    ]),
    feeCells: Object.freeze([
      Object.freeze({
        outPoint: feeOutPoint,
        output: Object.freeze({
          capacity: `0x${ownerChange.toString(16)}`,
          lock: ownerLock,
          type: null,
        }),
        data: "0x",
        blockHash: creationHeader.hash,
        blockNumber: creationHeader.number,
      }),
    ]),
    headers: Object.freeze([creationHeader]),
    resolvedLocks: Object.freeze([ownerLock, successLock]),
    payloads: Object.freeze([creation.intent.pledgeRecords]),
    claims: Object.freeze({ deadlineOutcome: expectedOutcome }),
  });
  const execution = runExecutorAdapter(registry, snapshot, {
    rewardLock: ownerLock,
    transactionFee: parseShannons(transactionFee),
  });
  assert.equal(execution.status, "built", `${label} must be eligible and self-verified`);
  if (execution.status !== "built") throw new Error(`${label} did not build`);
  assert.equal(execution.build.summary.outcome, expectedOutcome);
  const signedExecution = signSingleInput(
    execution.build.transaction,
    { lock: "", inputType: "", outputType: "" },
    undefined,
    1,
  );
  const dryRun = await rpc("dry_run_transaction", [toRpcTransaction(signedExecution)]);
  assert.ok(BigInt(dryRun.cycles) > 0n, `${label} must execute contract cycles`);
  const executionResult = await commit(signedExecution);
  const executionHash = parseHash32(executionResult.transaction.hash);
  await assertSpent(jobOutPoint, `${label} job input`);
  await assertSpent(campaignOutPoint, `${label} campaign input`);
  const terminalIndex = 3;
  const terminal = await rpc("get_live_cell", [
    { tx_hash: executionHash, index: `0x${terminalIndex.toString(16)}` },
    true,
  ]);
  assert.equal(terminal.status, "live", `${label} terminal campaign cell must remain live`);
  const terminalData = CampaignDataV1.unpack(
    Buffer.from(terminal.cell.data.content.slice(2), "hex"),
  );
  assert.equal(terminalData.state, expectedOutcome === "SUCCEEDED" ? 1 : 2);
  const feeChangeIndex = execution.build.transaction.outputs.length - 1;
  fundingOutPoint = parseOutPoint({ txHash: executionHash, index: feeChangeIndex.toString() });
  fundingCapacity = BigInt(execution.build.transaction.outputs[feeChangeIndex].capacity);
  console.log(
    `${label} committed ${executionHash} after ${dryRun.cycles} dry-run cycles (${expectedOutcome})`,
  );
}

await executeFixture("deadline success", "5000000000", "SUCCEEDED", "5001");
await executeFixture("deadline refund", "15000000000", "REFUNDING", "5002");
