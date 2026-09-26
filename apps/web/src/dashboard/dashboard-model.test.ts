import assert from "node:assert/strict";
import test from "node:test";

import type { ApiJobList } from "@ckb-automata/api-client";

import {
  dashboardJobPresentation,
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

test("dashboard summary preserves exact recipient amounts", () => {
  const items = [
    job("live", { jobId: `0x${"10".repeat(32)}` }),
    job("spent", {
      funds: { capacity: "123456789", executorReward: "0", remainingBudget: "0" },
      jobId: `0x${"20".repeat(32)}`,
    }),
    job("orphaned", { jobId: `0x${"30".repeat(32)}` }),
  ];
  const summary = dashboardSummary(items, {
    [items[0]!.jobId]: { perExecution: "10000000000", total: "30000000000" },
    [items[1]!.jobId]: { perExecution: "200000000", total: "200000000" },
    [items[2]!.jobId]: { perExecution: "300000000", total: "300000000" },
  });
  assert.deepEqual(summary, {
    recipientTotal: "305 CKB",
    live: 1,
    orphaned: 1,
    spent: 1,
    total: 3,
  });
  assert.equal(
    dashboardSummary(items, Object.fromEntries([[items[0]!.jobId, null]])).recipientTotal,
    "Unavailable",
  );
});
