import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bytes } from "@ckb-lumos/codec";

import { JobDataV1 } from "./generated/job_v1.ts";

interface JobFixture {
  version: number;
  flags: number;
  job_id: string;
  sequence: string;
  state: number;
  trigger_kind: number;
  trigger_params_hash: string;
  policy_script_hash: string;
  payload_hash: string;
  reward: string;
  remaining_budget: string;
  not_before: string;
  not_after: string;
  remaining_runs: number;
  cancel_lock_hash: string;
  expected_hex: string;
}

function byteArray(hex: string): number[] {
  return Array.from(bytes.bytify(hex));
}

test("JobDataV1 matches the cross-language fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/job_data_v1.json", import.meta.url),
      "utf8",
    ),
  ) as JobFixture;
  const encoded = JobDataV1.pack({
    version: fixture.version,
    flags: fixture.flags,
    job_id: byteArray(fixture.job_id),
    sequence: fixture.sequence,
    state: fixture.state,
    trigger_kind: fixture.trigger_kind,
    trigger_params_hash: byteArray(fixture.trigger_params_hash),
    policy_script_hash: byteArray(fixture.policy_script_hash),
    payload_hash: byteArray(fixture.payload_hash),
    reward: fixture.reward,
    remaining_budget: fixture.remaining_budget,
    not_before: fixture.not_before,
    not_after: fixture.not_after,
    remaining_runs: fixture.remaining_runs,
    cancel_lock_hash: byteArray(fixture.cancel_lock_hash),
  });

  assert.equal(bytes.hexify(encoded), fixture.expected_hex);
  assert.equal(JobDataV1.unpack(encoded).sequence.toString(), fixture.sequence);
});
