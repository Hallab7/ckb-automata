import assert from "node:assert/strict";
import test from "node:test";

import { createEpoch, encodeAbsoluteEpochSince, parseHash32, packEpoch } from "@ckb-automata/core";

import {
  DaoHarvestScheduler,
  assertDaoHarvestSubmissionWindow,
  evaluateDaoHarvestSchedule,
  reconcileDaoHarvestAttempt,
  type DaoHarvestScheduleRecord,
} from "./dao-harvest-scheduler.ts";

const jobId = parseHash32(`0x${"a".repeat(64)}`);
const txHash = parseHash32(`0x${"b".repeat(64)}`);
const otherHash = parseHash32(`0x${"c".repeat(64)}`);
const since = (number: bigint) =>
  encodeAbsoluteEpochSince(createEpoch({ number, index: 0n, length: 0n }));
const tip = (number: bigint) => packEpoch(createEpoch({ number, index: 0n, length: 0n }));

function record(overrides: Partial<DaoHarvestScheduleRecord> = {}): DaoHarvestScheduleRecord {
  return {
    jobId,
    sequence: 0n,
    remainingRuns: 4n,
    remainingBudget: 400n,
    executorReward: 100n,
    prepareStartSince: since(100n),
    prepareCutoffSince: since(104n),
    claimMaturitySince: null,
    endEpochSince: 0n,
    canonical: true,
    live: true,
    approvedPrepareExecutor: true,
    ...overrides,
  };
}

test("prepare scheduling opens at start and closes at the cutoff", () => {
  assert.equal(evaluateDaoHarvestSchedule(record(), tip(99n)).status, "waiting");
  assert.deepEqual(evaluateDaoHarvestSchedule(record(), tip(100n)), {
    status: "ready",
    operation: "prepare",
    jobId,
    sequence: "0",
  });
  assert.deepEqual(evaluateDaoHarvestSchedule(record(), tip(104n)), {
    status: "rollover",
    operation: "prepare",
    jobId,
    sequence: "0",
    reason: "missed_prepare_window",
  });
  assert.throws(() => assertDaoHarvestSubmissionWindow(record(), tip(104n)), /not allowed/);
});

test("roll waits for maturity and ignores the expired preparation window", () => {
  const rolling = record({
    sequence: 1n,
    claimMaturitySince: since(280n),
    endEpochSince: since(200n),
  });
  assert.equal(evaluateDaoHarvestSchedule(rolling, tip(279n)).status, "waiting");
  assert.deepEqual(evaluateDaoHarvestSchedule(rolling, tip(280n)), {
    status: "ready",
    operation: "roll",
    jobId,
    sequence: "1",
  });
});

test("authorization, budgets, spent inputs, end bounds, and reorgs fail closed", () => {
  assert.equal(
    evaluateDaoHarvestSchedule(record({ approvedPrepareExecutor: false }), tip(100n)).status,
    "terminal",
  );
  assert.equal(
    evaluateDaoHarvestSchedule(record({ remainingBudget: 99n }), tip(100n)).status,
    "terminal",
  );
  assert.equal(evaluateDaoHarvestSchedule(record({ live: false }), tip(100n)).status, "terminal");
  assert.equal(
    evaluateDaoHarvestSchedule(record({ endEpochSince: since(100n) }), tip(100n)).status,
    "terminal",
  );
  const reorg = evaluateDaoHarvestSchedule(record({ canonical: false }), tip(100n));
  assert.equal(reorg.status, "waiting");
  if (reorg.status === "waiting") assert.equal(reorg.reason, "reorg_recovery");
});

test("attempt reconciliation is duplicate-safe across contention, drops, and reorgs", () => {
  assert.equal(reconcileDaoHarvestAttempt(txHash, { kind: "pending" }), "pending");
  assert.equal(
    reconcileDaoHarvestAttempt(txHash, { kind: "committed", txHash, canonical: true }),
    "confirmed",
  );
  assert.equal(
    reconcileDaoHarvestAttempt(txHash, { kind: "committed", txHash, canonical: false }),
    "reorged",
  );
  assert.equal(
    reconcileDaoHarvestAttempt(txHash, { kind: "spent", spendingTxHash: otherHash }),
    "conflicted",
  );
  assert.equal(
    reconcileDaoHarvestAttempt(txHash, { kind: "dropped", inputRestored: true }),
    "retry",
  );
});

test("scheduler uses stable build identities and advances durable wake identities", async () => {
  const calls: unknown[][] = [];
  const scheduler = new DaoHarvestScheduler({
    enqueue: async (...args: unknown[]) => {
      calls.push(args);
      return {} as never;
    },
  });
  await scheduler.schedule(record(), tip(99n), 3);
  await scheduler.schedule(record(), tip(100n), 4);
  assert.equal(calls[0]?.[0], "evaluate");
  assert.match(String(calls[0]?.[2]), /wake-4$/);
  assert.equal(calls[1]?.[0], "build");
  assert.equal(calls[1]?.[2], `${jobId}/0`);
});
