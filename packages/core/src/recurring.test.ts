import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deriveRecurringPayloadHash, isValidRecurringSchedule } from "./recurring.ts";

interface RecurringFixture {
  policy_script_hash: string;
  expected_hex: string;
  expected_payload_hash: string;
}

function decodeHex(value: string): Uint8Array {
  const digits = value.startsWith("0x") ? value.slice(2) : value;
  if (digits.length % 2 !== 0) throw new RangeError("hex must contain whole bytes");
  return Uint8Array.from({ length: digits.length / 2 }, (_, index) =>
    Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16),
  );
}

function encodeHex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

test("recurring payload hash matches the Rust vector", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/recurring_payload_v1.json", import.meta.url),
      "utf8",
    ),
  ) as RecurringFixture;
  const actual = deriveRecurringPayloadHash(
    decodeHex(fixture.policy_script_hash),
    decodeHex(fixture.expected_hex),
  );
  assert.equal(encodeHex(actual), fixture.expected_payload_hash);
});

test("recurring schedule validation covers every reserved boundary", () => {
  assert.equal(
    isValidRecurringSchedule({
      amount: 1n,
      intervalBlocks: 1n,
      firstNotBefore: 1n,
      totalRuns: 1,
      finalRefundKind: 0,
    }),
    true,
  );
  for (const schedule of [
    { amount: 0n, intervalBlocks: 1n, firstNotBefore: 1n, totalRuns: 1, finalRefundKind: 0 },
    { amount: 1n, intervalBlocks: 0n, firstNotBefore: 1n, totalRuns: 1, finalRefundKind: 0 },
    { amount: 1n, intervalBlocks: 1n, firstNotBefore: 0n, totalRuns: 1, finalRefundKind: 0 },
    { amount: 1n, intervalBlocks: 1n, firstNotBefore: 1n << 56n, totalRuns: 1, finalRefundKind: 0 },
    { amount: 1n, intervalBlocks: 1n, firstNotBefore: 1n, totalRuns: 0, finalRefundKind: 0 },
    { amount: 1n, intervalBlocks: 1n, firstNotBefore: 1n, totalRuns: 1, finalRefundKind: 1 },
  ]) {
    assert.equal(isValidRecurringSchedule(schedule), false);
  }
});
