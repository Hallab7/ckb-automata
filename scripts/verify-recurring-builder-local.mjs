/* global fetch */

import { strict as assert } from "node:assert";

import {
  assertRecurringCompletion,
  buildRecurringCreation,
  deploymentRegistry,
  parseHash32,
  parseOutPoint,
  reconstructRecurringDisplayIntent,
} from "../packages/core/src/index.ts";
import {
  occupiedShannons,
  scriptHash,
  signSingleInput,
  toRpcTransaction,
} from "./lib/ckb-local.mjs";

const rpcUrl = process.env.CKB_RPC_URL ?? "http://127.0.0.1:58114";
const transactionFee = 1_000_000n;
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
assert.ok(genesisHash, "the deployment registry must contain the local network");
const loaded = await deploymentRegistry.load(genesisHash);
assert.equal(loaded.status, "ok", "the local deployment manifest must pass integrity checks");
if (loaded.status !== "ok") process.exit(1);
const deployment = loaded.deployment;

const fundingOutPoint = parseOutPoint({
  txHash: deployment.confirmation.verificationTransactionHash,
  index: "0x1",
});
const live = await rpc("get_live_cell", [{ tx_hash: fundingOutPoint.txHash, index: "0x1" }, false]);
assert.equal(live.status, "live", "the verification change cell must remain live");
const ownerLock = {
  codeHash: live.cell.output.lock.code_hash,
  hashType: live.cell.output.lock.hash_type,
  args: live.cell.output.lock.args,
};
const ownerLockHash = parseHash32(scriptHash(ownerLock));
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
  creatorNonce: "45",
  creationFee: {
    transactionBytes: { minimum: "500", maximum: "1000" },
    feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
  },
});
assert.equal(
  build.intent.policyScriptHash,
  "0xe0c7df1f5d5665cd704f8e6da6762fb503be380ebf87ca4c7cbb4dfe98953015",
);

const inputCapacity = BigInt(live.cell.output.capacity);
const lockedCapacity = BigInt(build.transaction.outputs[0].capacity);
const changeCapacity = inputCapacity - lockedCapacity - transactionFee;
assert.ok(
  changeCapacity >= occupiedShannons({ capacity: "0x0", lock: ownerLock, type: null }, "0x"),
  "the local verification cell must cover the Job Cell, fee, and valid change",
);
const completed = {
  ...build.transaction,
  inputs: [
    {
      since: "0x0",
      previousOutput: { txHash: fundingOutPoint.txHash, index: "0x1" },
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
assert.deepEqual(reconstructRecurringDisplayIntent(signed, deployment), build.displayIntent);
const result = await rpc("dry_run_transaction", [toRpcTransaction(signed)]);
assert.ok(BigInt(result.cycles) > 0n, "the dry run must execute contract cycles");
console.log(
  `Recurring builder dry run passed: ${result.cycles} cycles, intent ${build.intentHash}`,
);
