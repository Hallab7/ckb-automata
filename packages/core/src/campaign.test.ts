import assert from "node:assert/strict";
import test from "node:test";

import { determineCampaignOutcome, isAbsoluteBlockDeadline } from "./campaign.ts";

test("campaign outcome depends only on pledged capacity and target", () => {
  assert.equal(determineCampaignOutcome(99n, 100n), "REFUNDING");
  assert.equal(determineCampaignOutcome(100n, 100n), "SUCCEEDED");
  assert.equal(determineCampaignOutcome(101n, 100n), "SUCCEEDED");
});

test("campaign outcome rejects nonsensical accounting inputs", () => {
  assert.throws(() => determineCampaignOutcome(-1n, 100n), /pledged/);
  assert.throws(() => determineCampaignOutcome(0n, 0n), /target/);
});

test("campaign deadline is a non-zero absolute block since value", () => {
  assert.equal(isAbsoluteBlockDeadline(0n), false);
  assert.equal(isAbsoluteBlockDeadline(1n), true);
  assert.equal(isAbsoluteBlockDeadline((1n << 56n) - 1n), true);
  assert.equal(isAbsoluteBlockDeadline(1n << 56n), false);
  assert.equal(isAbsoluteBlockDeadline(1n << 63n), false);
});
