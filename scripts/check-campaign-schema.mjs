import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schemaUrl = new URL("../contracts/schemas/campaign_v1.mol", import.meta.url);
const content = await readFile(schemaUrl, "utf8");
const tableBody = content.match(/table\s+CampaignDataV1\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body;
assert.ok(tableBody, "CampaignDataV1 table body is missing");

const actualFields = [...tableBody.matchAll(/^\s+(\w+):\s+(\w+),\s*$/gm)].map(
  ([, field, type]) => `${field}:${type}`,
);
assert.deepEqual(actualFields, [
  "version:Uint16",
  "state:byte",
  "campaign_id:Byte32",
  "pledged:Uint64",
  "pledge_count:Uint32",
  "target:Uint64",
  "deadline_since:Uint64",
  "success_lock_hash:Byte32",
  "refund_commitment:Byte32",
]);

for (const requiredRule of [
  "unsigned little-endian",
  "0 = OPEN, 1 = SUCCEEDED, 2 = REFUNDING",
  "non-zero absolute block-number since",
  "pledged >= target",
  "otherwise REFUNDING",
  "ckb-automata/campaign-refunds/v1",
  "sorted lexicographically",
  "No subjective evidence",
]) {
  assert.ok(content.includes(requiredRule), `missing campaign rule: ${requiredRule}`);
}

for (const forbiddenInput of ["approval", "oracle", "api_value", "executor_decision"]) {
  assert.ok(
    !actualFields.some((field) => field.toLowerCase().includes(forbiddenInput)),
    `subjective campaign field is forbidden: ${forbiddenInput}`,
  );
}

console.log(`Campaign schema review passed: ${actualFields.length} ordered fields`);
