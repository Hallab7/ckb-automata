import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bytes } from "@ckb-lumos/codec";

import { RecurringPayloadV1 } from "./generated/recurring_v1.ts";

interface RecurringFixture {
  version: number;
  owner_lock_hash: string;
  recipient_lock_hash: string;
  amount: string;
  interval_blocks: string;
  first_not_before: string;
  total_runs: number;
  reward: string;
  final_refund_kind: number;
  expected_hex: string;
}

function byteArray(hex: string): number[] {
  return Array.from(bytes.bytify(hex));
}

test("RecurringPayloadV1 matches the cross-language fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/recurring_payload_v1.json", import.meta.url),
      "utf8",
    ),
  ) as RecurringFixture;
  const encoded = RecurringPayloadV1.pack({
    version: fixture.version,
    owner_lock_hash: byteArray(fixture.owner_lock_hash),
    recipient_lock_hash: byteArray(fixture.recipient_lock_hash),
    amount: fixture.amount,
    interval_blocks: fixture.interval_blocks,
    first_not_before: fixture.first_not_before,
    total_runs: fixture.total_runs,
    reward: fixture.reward,
    final_refund_kind: fixture.final_refund_kind,
  });

  assert.equal(bytes.hexify(encoded), fixture.expected_hex);
  const decoded = RecurringPayloadV1.unpack(encoded);
  assert.equal(decoded.amount.toString(), fixture.amount);
  assert.equal(decoded.total_runs, fixture.total_runs);
});
