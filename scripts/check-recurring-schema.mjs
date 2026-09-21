import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schemaUrl = new URL("../contracts/schemas/recurring_v1.mol", import.meta.url);
const content = await readFile(schemaUrl, "utf8");
const tableBody = content.match(/table\s+RecurringPayloadV1\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body;
assert.ok(tableBody, "RecurringPayloadV1 table body is missing");

const actualFields = [...tableBody.matchAll(/^\s+(\w+):\s+(\w+),\s*$/gm)].map(
  ([, field, type]) => `${field}:${type}`,
);
assert.deepEqual(actualFields, [
  "version:Uint16",
  "owner_lock_hash:Byte32",
  "recipient_lock_hash:Byte32",
  "amount:Uint64",
  "interval_blocks:Uint64",
  "first_not_before:Uint64",
  "total_runs:Uint32",
  "reward:Uint64",
  "final_refund_kind:byte",
]);

for (const requiredRule of [
  "unsigned little-endian",
  "exact non-zero native CKB payout",
  "exact non-zero distance",
  "non-zero absolute block-number since",
  "exact non-zero payout count",
  "RETURN_RESIDUAL_TO_OWNER",
  "mutable progress fields",
  "remain immutable across successors",
]) {
  assert.ok(content.includes(requiredRule), `missing recurring rule: ${requiredRule}`);
}

console.log(`Recurring schema review passed: ${actualFields.length} ordered fields`);
