/* global fetch */

import { strict as assert } from "node:assert";

import {
  assertDeadlineCompletion,
  buildDeadlineCreation,
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
const deadlineBlock = BigInt(tip.number) + 20n;
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
  deadlineBlock,
  successLockHash: ownerLockHash,
  cancelLockHash: ownerLockHash,
  reward: "10000000000",
  creatorNonce: "44",
  creationFee: {
    transactionBytes: { minimum: "700", maximum: "1200" },
    feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
  },
});

const lockedCapacity = build.transaction.outputs.reduce(
  (total, output) => total + BigInt(output.capacity),
  0n,
);
const inputCapacity = BigInt(live.cell.output.capacity);
const changeCapacity = inputCapacity - lockedCapacity - transactionFee;
assert.ok(
  changeCapacity >= occupiedShannons({ capacity: "0x0", lock: ownerLock, type: null }, "0x"),
  "the local verification cell must cover committed outputs, fee, and valid change",
);
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
const result = await rpc("dry_run_transaction", [toRpcTransaction(signed)]);
assert.ok(BigInt(result.cycles) > 0n, "the dry run must execute contract cycles");
console.log(`Deadline builder dry run passed: ${result.cycles} cycles, intent ${build.intentHash}`);
