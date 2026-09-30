import assert from "node:assert/strict";
import test from "node:test";

import { createEpoch } from "./chain-values.ts";
import {
  calculateDaoHarvestQuote,
  calculateDaoMaximumWithdraw,
  compareEpochFractions,
  nextDaoBoundary,
  selectDaoPrepareWindow,
} from "./dao-harvest-math.ts";

test("epoch comparison and next DAO boundary use exact fractions", () => {
  const deposit = createEpoch({ number: 100n, index: 1n, length: 3n });
  assert.equal(
    compareEpochFractions(deposit, createEpoch({ number: 100n, index: 2n, length: 6n })),
    0,
  );
  assert.deepEqual(nextDaoBoundary(deposit, createEpoch({ number: 280n, index: 1n, length: 3n })), {
    number: 460n,
    index: 1n,
    length: 3n,
  });
});

test("prepare window has an exact open and cutoff order", () => {
  const window = selectDaoPrepareWindow({
    deposit: createEpoch({ number: 10n, index: 1n, length: 2n }),
    tip: createEpoch({ number: 100n, index: 0n, length: 0n }),
    bufferEpochs: 4n,
    confirmationMarginEpochs: 1n,
  });
  assert.deepEqual(window.startsAt, { number: 186n, index: 1n, length: 2n });
  assert.deepEqual(window.cutsOffAt, { number: 189n, index: 1n, length: 2n });
  assert.throws(
    () =>
      selectDaoPrepareWindow({
        deposit: window.startsAt,
        tip: window.cutsOffAt,
        bufferEpochs: 1n,
        confirmationMarginEpochs: 1n,
      }),
    /buffer must exceed/,
  );
});

test("maximum withdraw matches the contract integer formula", () => {
  assert.equal(
    calculateDaoMaximumWithdraw({
      principal: 10_000n,
      occupiedCapacity: 1_000n,
      depositAccumulatedRate: 1_000n,
      withdrawingAccumulatedRate: 1_100n,
    }),
    10_900n,
  );
  assert.throws(
    () =>
      calculateDaoMaximumWithdraw({
        principal: 999n,
        occupiedCapacity: 1_000n,
        depositAccumulatedRate: 1_000n,
        withdrawingAccumulatedRate: 1_100n,
      }),
    /occupied/,
  );
});

test("economics quote keeps rewards and fees separate from principal", () => {
  const quote = calculateDaoHarvestQuote({
    principal: 10_000n,
    occupiedCapacity: 1_000n,
    depositAccumulatedRate: 1_000n,
    projectedWithdrawAccumulatedRate: 1_100n,
    executorReward: 100n,
    actions: 4n,
    estimatedNetworkFee: 20n,
    snapshotBlock: 50n,
    validUntilBlock: 60n,
    currentBlock: 59n,
  });
  assert.equal(quote.projectedCompensation, 900n);
  assert.equal(quote.actionBudget, 400n);
  assert.equal(quote.totalRequired, 10_420n);
  assert.equal(quote.projectedNetBenefit, 480n);
  assert.throws(
    () =>
      calculateDaoHarvestQuote({
        principal: 10_000n,
        occupiedCapacity: 1_000n,
        depositAccumulatedRate: 1_000n,
        projectedWithdrawAccumulatedRate: 1_100n,
        executorReward: 100n,
        actions: 4n,
        estimatedNetworkFee: 20n,
        snapshotBlock: 50n,
        validUntilBlock: 60n,
        currentBlock: 61n,
      }),
    /expired/,
  );
});
