import assert from "node:assert/strict";
import test from "node:test";

import { calculateEpochWindow, MAX_EPOCH_NUMBER } from "./nervdao-model.ts";

test("calculates the first future boundary on a 180-epoch cadence", () => {
  assert.deepEqual(
    calculateEpochWindow({ currentEpoch: "1240", depositEpoch: "1000", preparationBuffer: "6" }),
    {
      cycleNumber: 2,
      estimatedTime: "20 days",
      nextBoundary: 1360,
      preparationStart: 1354,
      remainingEpochs: 120,
      windowOpen: false,
    },
  );
});

test("moves to the following boundary when the current epoch equals a boundary", () => {
  const result = calculateEpochWindow({
    currentEpoch: "1180",
    depositEpoch: "1000",
    preparationBuffer: "6",
  });
  assert.equal(result.nextBoundary, 1360);
  assert.equal(result.cycleNumber, 2);
});

test("reports an open illustrative preparation window", () => {
  const result = calculateEpochWindow({
    currentEpoch: "1176",
    depositEpoch: "1000",
    preparationBuffer: "6",
  });
  assert.equal(result.nextBoundary, 1180);
  assert.equal(result.windowOpen, true);
  assert.equal(result.estimatedTime, "16 hours");
});

test("rejects malformed, reversed, and out-of-range epoch inputs", () => {
  assert.throws(
    () =>
      calculateEpochWindow({ currentEpoch: "999", depositEpoch: "1000", preparationBuffer: "6" }),
    /earlier than the deposit/,
  );
  assert.throws(
    () => calculateEpochWindow({ currentEpoch: "1.5", depositEpoch: "1", preparationBuffer: "6" }),
    /whole number/,
  );
  assert.throws(
    () =>
      calculateEpochWindow({ currentEpoch: "100", depositEpoch: "1", preparationBuffer: "180" }),
    /between 1 and 179/,
  );
  assert.throws(
    () =>
      calculateEpochWindow({
        currentEpoch: MAX_EPOCH_NUMBER.toString(),
        depositEpoch: MAX_EPOCH_NUMBER.toString(),
        preparationBuffer: "1",
      }),
    /exceeds the supported/,
  );
});
