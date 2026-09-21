import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const schemaDirectory = new URL("../contracts/schemas/", import.meta.url);
const schemaFiles = (await readdir(schemaDirectory)).filter((name) => name.endsWith(".mol"));
const definingFiles = [];

for (const name of schemaFiles) {
  const content = await readFile(new URL(name, schemaDirectory), "utf8");
  if (/\btable\s+JobDataV1\s*\{/.test(content)) {
    definingFiles.push({ content, name });
  }
}

assert.equal(definingFiles.length, 1, "exactly one Molecule file must define JobDataV1");

const [{ content, name }] = definingFiles;
const tableBody = content.match(/table\s+JobDataV1\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body;
assert.ok(tableBody, "JobDataV1 table body is missing");

const actualFields = [...tableBody.matchAll(/^\s+(\w+):\s+(\w+),\s*$/gm)].map(
  ([, field, type]) => `${field}:${type}`,
);
const expectedFields = [
  "version:Uint16",
  "flags:Uint16",
  "job_id:Byte32",
  "sequence:Uint64",
  "state:byte",
  "trigger_kind:Uint16",
  "trigger_params_hash:Byte32",
  "policy_script_hash:Byte32",
  "payload_hash:Byte32",
  "reward:Uint64",
  "remaining_budget:Uint64",
  "not_before:Uint64",
  "not_after:Uint64",
  "remaining_runs:Uint32",
  "cancel_lock_hash:Byte32",
];
assert.deepEqual(actualFields, expectedFields, "JobDataV1 field order changed");

for (const requiredRule of [
  "unsigned little-endian",
  "shannons",
  "0 = LIVE",
  "7..65535 are reserved",
  "MUST be at least 1",
  "ckb-automata/trigger-params/v1",
  "ckb-automata/policy-payload/v1",
  "ckb-automata/job-id/v1",
  "uint16_le(protocol_version)",
  "Anchor tag 0 uses uint64_le(output_index); tag 1 uses a 32-byte Type ID",
  "prevent cross-network and cross-version",
]) {
  assert.ok(content.includes(requiredRule), `missing schema rule: ${requiredRule}`);
}

for (const applicationField of [
  "dao",
  "deposit",
  "withdraw",
  "prepare",
  "claim",
  "campaign_stage",
]) {
  assert.ok(
    !actualFields.some((field) => field.toLowerCase().includes(applicationField)),
    `application-specific field is forbidden: ${applicationField}`,
  );
}

console.log(`Schema review passed: ${name}, ${actualFields.length} ordered fields`);
