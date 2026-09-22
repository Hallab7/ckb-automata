/* global fetch */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import {
  assertRecurringCompletion,
  assertTopUpCompletion,
  buildRecurringCreation,
  buildTopUp,
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
const transactionFee = 1_000_000n;
const topUpCapacity = 10_000_000_000n;
let rpcId = 0;

if (!minerContainer) {
  throw new Error("CKB_MINER_CONTAINER is required for the stateful top-up proof");
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
assert.equal(funding.status, "live", "run this proof against a freshly deployed disposable chain");
const ownerLock = fromRpcScript(funding.cell.output.lock);
const ownerLockHash = parseHash32(scriptHash(ownerLock));
const tip = await rpc("get_tip_header");
const creation = buildRecurringCreation({
  deployment,
  ownerLockHash,
  recipientLockHash: ownerLockHash,
  amount: "10000000000",
  intervalBlocks: "10",
  firstNotBefore: BigInt(tip.number) + 20n,
  totalRuns: "2",
  reward: "10000000000",
  creatorNonce: "48",
  creationFee: {
    transactionBytes: { minimum: "500", maximum: "1000" },
    feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
  },
});
const creationChangeCapacity =
  BigInt(funding.cell.output.capacity) -
  BigInt(creation.transaction.outputs[0].capacity) -
  transactionFee;
assert.ok(
  creationChangeCapacity >=
    occupiedShannons({ capacity: "0x0", lock: ownerLock, type: null }, "0x"),
  "the fixture funding cell must cover creation and change",
);
const completedCreation = {
  ...creation.transaction,
  inputs: [
    {
      since: "0x0",
      previousOutput: { txHash: fundingOutPoint.txHash, index: "0x1" },
    },
  ],
  outputs: [
    ...creation.transaction.outputs,
    { capacity: `0x${creationChangeCapacity.toString(16)}`, lock: ownerLock, type: null },
  ],
  outputsData: [...creation.transaction.outputsData, "0x"],
};
const signedCreation = signSingleInput(completedCreation, {
  lock: "",
  inputType: "",
  outputType: creation.completion.requiredOutputType,
});
assertRecurringCompletion(creation, signedCreation);
const creationHash = await commit(signedCreation);
const jobOutPoint = parseOutPoint({ txHash: creationHash, index: "0x0" });

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
const topUp = await buildTopUp({
  deployment,
  resolver,
  jobOutPoint,
  ownerLock,
  rewardIncrease: "0",
  budgetIncrease: topUpCapacity,
  capacityIncrease: topUpCapacity,
});
assert.equal(topUp.diff.classification, "top_up");
assert.deepEqual(topUp.diff.immutableChanges, []);
const ownerChangeOutPoint = parseOutPoint({ txHash: creationHash, index: "0x1" });
const nextOwnerCapacity = creationChangeCapacity - topUpCapacity - transactionFee;
const completedTopUp = {
  ...topUp.transaction,
  inputs: [
    ...topUp.transaction.inputs,
    {
      since: "0x0",
      previousOutput: { txHash: ownerChangeOutPoint.txHash, index: "0x1" },
    },
  ],
  outputs: [
    ...topUp.transaction.outputs,
    { capacity: `0x${nextOwnerCapacity.toString(16)}`, lock: ownerLock, type: null },
  ],
  outputsData: [...topUp.transaction.outputsData, "0x"],
};
const signedTopUp = signSingleInput(
  completedTopUp,
  { lock: "", inputType: "", outputType: "" },
  undefined,
  1,
);
assertTopUpCompletion(topUp, signedTopUp);
const dryRun = await rpc("dry_run_transaction", [toRpcTransaction(signedTopUp)]);
assert.ok(BigInt(dryRun.cycles) > 0n, "the top-up must execute contract cycles");
const topUpHash = await commit(signedTopUp);
assert.equal(await resolver.resolve(jobOutPoint), null, "the predecessor Job Cell must be spent");
const successor = await resolver.resolve(parseOutPoint({ txHash: topUpHash, index: "0x0" }));
assert.ok(successor, "the topped-up successor must remain live");
console.log(
  `Top-up builder committed ${topUpHash} after ${dryRun.cycles} dry-run cycles with unchanged intent`,
);
