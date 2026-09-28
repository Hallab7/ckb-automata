import assert from "node:assert/strict";
import test from "node:test";

import type { ApiJobList } from "@ckb-automata/api-client";

import {
  dashboardJobPresentation,
  dashboardPageRange,
  dashboardSummary,
  type DashboardJob,
} from "./dashboard-model.ts";

function job(state: DashboardJob["state"], overrides: Partial<DashboardJob> = {}): DashboardJob {
  return {
    cancellationLockHash: `0x${"11".repeat(32)}`,
    funds: { capacity: "20000000000", executorReward: "100000000", remainingBudget: "500000000" },
    jobId: `0x${"22".repeat(32)}`,
    network: "testnet",
    ownerLockHash: `0x${"33".repeat(32)}`,
    payloadHash: `0x${"44".repeat(32)}`,
    policyScriptHash: `0x${"55".repeat(32)}`,
    protocol: { flags: 0, rawData: "0x", version: 1 },
    remainingRuns: "3",
    sequence: "0",
    source: {
      block: { hash: `0x${"66".repeat(32)}`, number: "90", transactionIndex: "0" },
      canonical: state !== "orphaned",
      indexCheckpoint: { blockHash: `0x${"77".repeat(32)}`, blockNumber: "100" },
      outPoint: { index: "0", txHash: `0x${"88".repeat(32)}` },
    },
    state,
    template: "recurring",
    trigger: {
      kind: 0,
      metric: "block",
      notAfter: "200",
      notBefore: "110",
      paramsHash: `0x${"99".repeat(32)}`,
    },
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  } as ApiJobList["items"][number];
}

test("dashboard derives every lifecycle and operational status from canonical reads", () => {
  const amounts = { perExecution: "10000000000", total: "30000000000" };
  assert.equal(dashboardJobPresentation(job("live"), "100", amounts).status, "waiting");
  assert.equal(dashboardJobPresentation(job("live"), "110", amounts).status, "processing");
  assert.equal(
    dashboardJobPresentation(
      job("live", {
        funds: { capacity: "20000000000", executorReward: "100000000", remainingBudget: "0" },
      }),
      "110",
      amounts,
    ).status,
    "needs_funding",
  );
  assert.equal(
    dashboardJobPresentation(
      job("live", {
        funds: { capacity: "20000000000", executorReward: "100000000", remainingBudget: "0" },
        trigger: {
          kind: 0,
          metric: "block",
          notAfter: "105",
          notBefore: "90",
          paramsHash: `0x${"99".repeat(32)}`,
        },
      }),
      "110",
      amounts,
    ).status,
    "recovery_required",
  );
  const completed = dashboardJobPresentation(job("spent"), "110", null);
  assert.equal(completed.status, "completed");
  assert.equal(completed.runsRemaining, "0");
  assert.equal(dashboardJobPresentation(job("orphaned"), "110", null).status, "reorged");
});

test("dashboard summary preserves exact server-wide recipient amounts", () => {
  const summary = dashboardSummary({
    nextJob: null,
    nextRecipientAmount: null,
    recipientTotal: "30500000000",
    states: { confirming: 2, live: 1, orphaned: 1, spent: 1, submitting: 1 },
    totalItems: 6,
  });
  assert.deepEqual(summary, {
    recipientTotal: "305 CKB",
    confirming: 2,
    live: 1,
    orphaned: 1,
    spent: 1,
    submitting: 1,
    total: 6,
  });
  assert.equal(
    dashboardSummary({
      nextJob: null,
      nextRecipientAmount: null,
      recipientTotal: null,
      states: { confirming: 0, live: 0, orphaned: 0, spent: 0, submitting: 0 },
      totalItems: 0,
    }).recipientTotal,
    "Temporarily unavailable",
  );
});

test("dashboard summary and page range use the complete filtered total", () => {
  assert.deepEqual(dashboardPageRange(0, 12, 12, 14), { first: 1, last: 12, totalPages: 2 });
  assert.deepEqual(dashboardPageRange(1, 12, 2, 14), { first: 13, last: 14, totalPages: 2 });
});
