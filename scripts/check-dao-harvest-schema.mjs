import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schemaUrl = new URL("../contracts/schemas/dao_harvest_v1.mol", import.meta.url);
const content = await readFile(schemaUrl, "utf8");
const tableBody = content.match(/table\s+DaoHarvestPayloadV1\s*\{(?<body>[\s\S]*?)\}/)?.groups
  ?.body;
assert.ok(tableBody, "DaoHarvestPayloadV1 table body is missing");

const actualFields = [...tableBody.matchAll(/^\s+(\w+):\s+(\w+),\s*$/gm)].map(
  ([, field, type]) => `${field}:${type}`,
);
assert.deepEqual(actualFields, [
  "version:Uint16",
  "owner_lock_hash:Byte32",
  "payout_lock_hash:Byte32",
  "vault_lock_hash:Byte32",
  "dao_type_hash:Byte32",
  "principal_capacity:Uint64",
  "prepare_executor_set_hash:Byte32",
  "executor_reward:Uint64",
  "min_compensation:Uint64",
  "prepare_buffer_epochs:Uint64",
  "confirmation_margin_epochs:Uint64",
  "total_cycles:Uint32",
  "end_epoch_since:Uint64",
]);

for (const requiredRule of [
  "unsigned little-endian",
  "exact full capacity",
  "full deployed Nervos DAO type script hash",
  "sorted unique executor lock hashes",
  "exact separately funded reward",
  "MUST be less than prepare_buffer_epochs",
  "cutoff is operational metadata",
  "total_cycles * 2",
  "ckb-automata/policy-payload/v1",
  "eight zero bytes",
  "WITHDRAWING",
]) {
  assert.ok(content.includes(requiredRule), `missing DAO harvest schema rule: ${requiredRule}`);
}

for (const forbiddenProgressField of [
  "state",
  "sequence",
  "remaining_cycles",
  "deposit_out_point",
  "deposit_tx_hash",
  "deposit_output_index",
  "target_boundary",
  "prepare_start",
  "prepare_cutoff",
]) {
  assert.ok(
    !actualFields.some((field) => field.startsWith(`${forbiddenProgressField}:`)),
    `mutable progress field is forbidden in immutable payload: ${forbiddenProgressField}`,
  );
}

console.log(`DAO harvest schema review passed: ${actualFields.length} ordered immutable fields`);
