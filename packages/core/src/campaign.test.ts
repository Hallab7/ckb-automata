import assert from "node:assert/strict";
import test from "node:test";

import { determineCampaignOutcome, isAbsoluteBlockDeadline } from "./campaign.ts";
import { parseBlockNumber, parseShannons, type BlockNumber } from "./chain-values.ts";

test("campaign outcome depends only on pledged capacity and target", () => {
  assert.equal(determineCampaignOutcome(parseShannons(99n), parseShannons(100n)), "REFUNDING");
  assert.equal(determineCampaignOutcome(parseShannons(100n), parseShannons(100n)), "SUCCEEDED");
  assert.equal(determineCampaignOutcome(parseShannons(101n), parseShannons(100n)), "SUCCEEDED");
});

test("campaign outcome rejects nonsensical accounting inputs", () => {
  assert.throws(
    () => determineCampaignOutcome(parseShannons(-1n), parseShannons(100n)),
    /shannons/,
  );
  assert.throws(() => determineCampaignOutcome(parseShannons(0n), parseShannons(0n)), /target/);
});

test("campaign deadline is a non-zero absolute block since value", () => {
  assert.equal(isAbsoluteBlockDeadline(parseBlockNumber(0n)), false);
  assert.equal(isAbsoluteBlockDeadline(parseBlockNumber(1n)), true);
  assert.equal(isAbsoluteBlockDeadline(parseBlockNumber((1n << 56n) - 1n)), true);
  assert.equal(isAbsoluteBlockDeadline(parseBlockNumber(1n << 56n)), false);
  assert.equal(isAbsoluteBlockDeadline(parseBlockNumber(1n << 63n)), false);
  assert.throws(() => isAbsoluteBlockDeadline(1 as unknown as BlockNumber), TypeError);
});
