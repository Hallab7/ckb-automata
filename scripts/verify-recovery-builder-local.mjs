/* global fetch */

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { JobDataV1 } from "../packages/molecule/src/generated/job_v1.ts";

import {
  assertDeadlineCompletion,
  assertRecoveryCompletion,
  assertRecurringCompletion,
  buildDeadlineCreation,
  buildRecovery,
  buildRecurringCreation,
  deploymentRegistry,
  parseHash32,
  parseOutPoint,
} from "../packages/core/src/index.ts";
import {
  occupiedShannons,
  scriptHash,
  signSingleInput,
  toRpcTransaction,
} from "./lib/ckb-local.mjs";

const rpcUrl = process.env.CKB_RPC_URL ?? "http://127.0.0.1:58114";
const minerContainer = process.env.CKB_MINER_CONTAINER;
const initialFundingTxHash = process.env.RECOVERY_FUNDING_TX_HASH;
const initialFundingIndex = process.env.RECOVERY_FUNDING_INDEX ?? "0x1";
const transactionFee = 1_000_000n;
const rawJobCapacity = 200_000_000_000n;
let rpcId = 0;

if (!minerContainer) {
  throw new Error("CKB_MINER_CONTAINER is required for the stateful recovery proof");
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
    if (result?.tx_status?.status === "committed") return txHash;
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

function encodeJob(data, overrides) {
  const decoded = JobDataV1.unpack(Uint8Array.from(Buffer.from(data.slice(2), "hex")));
  return `0x${Buffer.from(JobDataV1.pack({ ...decoded, ...overrides })).toString("hex")}`;
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
let fundingCapacity = BigInt(funding.cell.output.capacity);

const resolver = {
  async resolve(outPoint) {
    const live = await rpc("get_live_cell", [
      { tx_hash: outPoint.txHash, index: `0x${outPoint.index.toString(16)}` },
      true,
    ]);
    if (live.status !== "live") return null;
    return {
      outPoint,
      output: {
        capacity: live.cell.output.capacity,
        lock: fromRpcScript(live.cell.output.lock),
        type: live.cell.output.type ? fromRpcScript(live.cell.output.type) : null,
      },
      data: live.cell.data.content,
    };
  },
};

async function recover(label, jobOutPoint, ownerChangeOutPoint, ownerChangeCapacity, reason) {
  const recovery = await buildRecovery({
    deployment,
    resolver,
    jobOutPoint,
    ownerLock,
    reason,
  });
  const nextCapacity = ownerChangeCapacity - transactionFee;
  const completed = {
    ...recovery.transaction,
    inputs: [
      ...recovery.transaction.inputs,
      {
        since: "0x0",
        previousOutput: {
          txHash: ownerChangeOutPoint.txHash,
          index: `0x${ownerChangeOutPoint.index.toString(16)}`,
        },
      },
    ],
    outputs: [
      ...recovery.transaction.outputs,
      { capacity: `0x${nextCapacity.toString(16)}`, lock: ownerLock, type: null },
    ],
    outputsData: [...recovery.transaction.outputsData, "0x"],
  };
  const signed = signSingleInput(
    completed,
    { lock: "", inputType: "", outputType: "" },
    undefined,
    1,
  );
  assertRecoveryCompletion(recovery, signed);
  const dryRun = await rpc("dry_run_transaction", [toRpcTransaction(signed)]);
  assert.ok(BigInt(dryRun.cycles) > 0n, `${label} must execute contract cycles`);
  const txHash = await commit(signed);
  assert.equal(await resolver.resolve(jobOutPoint), null, `${label} Job Cell must be spent`);
  console.log(`${label} recovery committed in ${txHash} (${dryRun.cycles} cycles)`);
  return {
    outPoint: parseOutPoint({ txHash, index: "0x1" }),
    capacity: nextCapacity,
  };
}

async function createRecurring() {
  const tip = await rpc("get_tip_header");
  const build = buildRecurringCreation({
    deployment,
    ownerLockHash,
    recipientLockHash: ownerLockHash,
    amount: "10000000000",
    intervalBlocks: "10",
    firstNotBefore: BigInt(tip.number) + 20n,
    totalRuns: "2",
    reward: "10000000000",
    creatorNonce: "4701",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "1000" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const jobCapacity = BigInt(build.transaction.outputs[0].capacity);
  const changeCapacity = fundingCapacity - jobCapacity - transactionFee;
  const completed = {
    ...build.transaction,
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
      ...build.transaction.outputs,
      { capacity: `0x${changeCapacity.toString(16)}`, lock: ownerLock, type: null },
    ],
    outputsData: [...build.transaction.outputsData, "0x"],
  };
  const signed = signSingleInput(completed, {
    lock: "",
    inputType: "",
    outputType: build.completion.requiredOutputType,
  });
  assertRecurringCompletion(build, signed);
  const txHash = await commit(signed);
  return {
    data: build.jobData,
    jobOutPoint: parseOutPoint({ txHash, index: "0x0" }),
    ownerChangeOutPoint: parseOutPoint({ txHash, index: "0x1" }),
    ownerChangeCapacity: changeCapacity,
  };
}

async function createDeadline() {
  const tip = await rpc("get_tip_header");
  const build = buildDeadlineCreation({
    deployment,
    pledges: [
      {
        outPoint: fundingOutPoint,
        refundLockHash: ownerLockHash,
        amount: "10000000000",
      },
    ],
    target: "15000000000",
    deadlineBlock: BigInt(tip.number) + 20n,
    successLockHash: ownerLockHash,
    cancelLockHash: ownerLockHash,
    reward: "10000000000",
    creatorNonce: "4702",
    creationFee: {
      transactionBytes: { minimum: "700", maximum: "1200" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const lockedCapacity = build.transaction.outputs.reduce(
    (total, output) => total + BigInt(output.capacity),
    0n,
  );
  const changeCapacity = fundingCapacity - lockedCapacity - transactionFee;
  const completed = {
    ...build.transaction,
    outputs: [
      ...build.transaction.outputs,
      { capacity: `0x${changeCapacity.toString(16)}`, lock: ownerLock, type: null },
    ],
    outputsData: [...build.transaction.outputsData, "0x"],
  };
  const signed = signSingleInput(completed, {
    lock: "",
    inputType: "",
    outputType: build.completion.requiredOutputType,
  });
  assertDeadlineCompletion(build, signed);
  const txHash = await commit(signed);
  return {
    jobOutPoint: parseOutPoint({ txHash, index: "0x1" }),
    ownerChangeOutPoint: parseOutPoint({ txHash, index: "0x2" }),
    ownerChangeCapacity: changeCapacity,
  };
}

async function createRawJob(data) {
  const changeCapacity = fundingCapacity - rawJobCapacity - transactionFee;
  assert.ok(
    changeCapacity >= occupiedShannons({ capacity: "0x0", lock: ownerLock, type: null }, "0x"),
    "raw recovery fixture must retain valid owner change",
  );
  const jobLock = { ...deployment.contracts["job-lock"].script, args: "0x" };
  const transaction = {
    version: "0x0",
    cellDeps: [deployment.manifest.secp256k1Blake160.cellDep],
    headerDeps: [],
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
      { capacity: `0x${rawJobCapacity.toString(16)}`, lock: jobLock, type: null },
      { capacity: `0x${changeCapacity.toString(16)}`, lock: ownerLock, type: null },
    ],
    outputsData: [data, "0x"],
    witnesses: [],
  };
  const signed = signSingleInput(transaction, { lock: "", inputType: "", outputType: "" });
  const txHash = await commit(signed);
  return {
    jobOutPoint: parseOutPoint({ txHash, index: "0x0" }),
    ownerChangeOutPoint: parseOutPoint({ txHash, index: "0x1" }),
    ownerChangeCapacity: changeCapacity,
  };
}

const recurring = await createRecurring();
({ outPoint: fundingOutPoint, capacity: fundingCapacity } = await recover(
  "recurring terminal failure",
  recurring.jobOutPoint,
  recurring.ownerChangeOutPoint,
  recurring.ownerChangeCapacity,
  "terminal_operational_failure",
));

const deadline = await createDeadline();
({ outPoint: fundingOutPoint, capacity: fundingCapacity } = await recover(
  "deadline terminal failure",
  deadline.jobOutPoint,
  deadline.ownerChangeOutPoint,
  deadline.ownerChangeCapacity,
  "terminal_operational_failure",
));

for (const fixture of [
  { label: "missing policy", data: recurring.data, reason: "unsupported_metadata" },
  {
    label: "unsupported schema version",
    data: encodeJob(recurring.data, { version: 2 }),
    reason: "unsupported_metadata",
  },
  {
    label: "invalid application state",
    data: encodeJob(recurring.data, { state: 1 }),
    reason: "invalid_application_state",
  },
  {
    label: "invalid run counter",
    data: encodeJob(recurring.data, { remaining_runs: 0 }),
    reason: "invalid_application_state",
  },
]) {
  const raw = await createRawJob(fixture.data);
  ({ outPoint: fundingOutPoint, capacity: fundingCapacity } = await recover(
    fixture.label,
    raw.jobOutPoint,
    raw.ownerChangeOutPoint,
    raw.ownerChangeCapacity,
    fixture.reason,
  ));
}

console.log("Recovery builder passed all six funded local-chain states");
