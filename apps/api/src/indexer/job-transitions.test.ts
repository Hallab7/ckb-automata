import assert from "node:assert/strict";
import test from "node:test";

import { WitnessArgs } from "@ckb-ccc/shell";

import { classifyJobTransition, executorLockHashFromWitness } from "./job-transitions.ts";

function witness(inputType: `0x${string}`): string {
  return WitnessArgs.from({ inputType }).toHex();
}

const execute = witness(`0x00${"00000000"}${"11".repeat(32)}01${"00000000"}`);

test("classifies one-shot and recurring execution from successor presence", () => {
  assert.equal(classifyJobTransition(execute, false), "one_shot");
  assert.equal(classifyJobTransition(execute, true), "recurring");
  assert.equal(executorLockHashFromWitness(execute), `0x${"11".repeat(32)}`);
});

test("classifies cancellation, recovery, and top-up witness modes", () => {
  assert.equal(classifyJobTransition(witness("0x01"), false), "cancelled");
  assert.equal(classifyJobTransition(witness("0x02"), false), "recovered");
  assert.equal(classifyJobTransition(witness("0x0300000000"), true), "topped_up");
});

test("records malformed and contradictory consumption as consumed by other", () => {
  assert.equal(classifyJobTransition("0x", false), "consumed_by_other");
  assert.equal(executorLockHashFromWitness("0x"), undefined);
  assert.equal(classifyJobTransition(witness("0x01"), true), "consumed_by_other");
  assert.equal(classifyJobTransition(witness("0x0300000000"), false), "consumed_by_other");
});
