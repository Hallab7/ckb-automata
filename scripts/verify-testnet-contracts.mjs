/* global fetch */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ckbHash, parseDepGroup, scriptHash } from "./lib/ckb-local.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("deploy/manifests/testnet.json", root), "utf8"));
const rpcUrl = process.env.CKB_TESTNET_RPC_URL ?? manifest.rpcUrl;
const requiredConfirmationDepth = 24n;
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

async function liveCell(cellDep, withData = true) {
  const result = await rpc("get_live_cell", [
    {
      tx_hash: cellDep.outPoint.txHash,
      index: cellDep.outPoint.index,
    },
    withData,
  ]);
  assert.equal(result.status, "live", `${cellDep.outPoint.txHash}:${cellDep.outPoint.index}`);
  return result.cell;
}

const genesis = await rpc("get_block_by_number", ["0x0"]);
assert.equal(genesis.header.hash, manifest.genesisHash, "testnet genesis mismatch");

const deployment = await rpc("get_transaction", [manifest.deployment.transactionHash]);
assert.equal(deployment.tx_status.status, "committed", "deployment is not committed");
assert.equal(deployment.tx_status.block_hash, manifest.deployment.blockHash);
const [deploymentHeader, tipHeader] = await Promise.all([
  rpc("get_header", [manifest.deployment.blockHash]),
  rpc("get_tip_header"),
]);
const confirmationDepth = BigInt(tipHeader.number) - BigInt(deploymentHeader.number) + 1n;
assert.ok(
  confirmationDepth >= requiredConfirmationDepth,
  `deployment has ${confirmationDepth} confirmations; ${requiredConfirmationDepth} required`,
);

for (const [name, contract] of Object.entries(manifest.contracts)) {
  assert.equal(contract.cellDep.depType, "code", `${name} must use a code cell dep`);
  const cell = await liveCell(contract.cellDep);
  const data = Buffer.from(cell.data.content.slice(2), "hex");
  assert.equal(data.length, contract.sizeBytes, `${name} size mismatch`);
  assert.equal(
    createHash("sha256").update(data).digest("hex"),
    contract.binarySha256,
    `${name} SHA-256 mismatch`,
  );
  assert.equal(ckbHash(data), contract.codeHash, `${name} CKB data hash mismatch`);
  assert.deepEqual(cell.output.lock, {
    args: "0x",
    code_hash: `0x${"00".repeat(32)}`,
    hash_type: "data1",
  });
  assert.equal(cell.output.type, null, `${name} code cell must not have a type script`);
}

const secpDepGroup = await liveCell(manifest.secp256k1Blake160.cellDep);
const groupedOutPoints = parseDepGroup(secpDepGroup.data.content);
assert.ok(groupedOutPoints.length > 0, "secp256k1 dependency group is empty");
let secpCodeResolved = false;
for (const outPoint of groupedOutPoints) {
  const cell = await liveCell({ outPoint, depType: "code" }, false);
  const type = cell.output.type;
  if (
    type &&
    scriptHash({ codeHash: type.code_hash, hashType: type.hash_type, args: type.args }) ===
      manifest.secp256k1Blake160.codeHash
  ) {
    secpCodeResolved = true;
  }
}
assert.ok(secpCodeResolved, "secp256k1 dependency group does not contain the declared code cell");

const fixtureCases = [
  ["job-lock", "execution_mode::permissionless_execution_binds_policy_identity_and_reward"],
  [
    "deadline-policy",
    "campaign_success::deadline_adapter_binds_policy_payload_reward_and_termination",
  ],
  ["recurring-policy", "recurring_payout::recurring_policy_pays_the_exact_committed_native_amount"],
  ["demo-campaign-type", "campaign_creation::deterministic_campaign_fixture_can_be_created"],
  ["campaign-lock", "campaign_lock::empty_args_allow_permissionless_campaign_consumption"],
];
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
for (const [name, fixture] of fixtureCases) {
  execFileSync(cargo, ["test-native", "--locked", fixture, "--", "--exact"], {
    cwd: fileURLToPath(root),
    stdio: "inherit",
  });
  console.log(`Verified ${name} with ${fixture}`);
}

console.log(
  `Resolved ${Object.keys(manifest.contracts).length} immutable testnet code cells at ${confirmationDepth} confirmations`,
);
