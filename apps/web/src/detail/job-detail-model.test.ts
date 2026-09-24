import assert from "node:assert/strict";
import test from "node:test";

import type { ApiJob, ApiJobEvents } from "@ckb-automata/api-client";

import { eventLabel, jobDetailPresentation, mergeTimeline } from "./job-detail-model.ts";

const HASH = `0x${"11".repeat(32)}`;

function job(overrides: Partial<ApiJob> = {}): ApiJob {
  return {
    cancellationLockHash: HASH,
    funds: { capacity: "12500000000", executorReward: "100000000", remainingBudget: "500000000" },
    jobId: HASH,
    network: "ckb_dev",
    ownerLockHash: HASH,
    payloadHash: HASH,
    policyScriptHash: HASH,
    protocol: { flags: 0, rawData: "0x", version: 1 },
    remainingRuns: "4",
    sequence: "2",
    source: {
      block: { hash: HASH, number: "100", transactionIndex: "0" },
      canonical: true,
      indexCheckpoint: { blockHash: HASH, blockNumber: "120" },
      outPoint: { index: "0", txHash: HASH },
    },
    state: "live",
    template: "recurring",
    trigger: { kind: 0, metric: "block", notAfter: "200", notBefore: "140", paramsHash: HASH },
    updatedAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

function event(
  eventId: string,
  options: {
    readonly confidence?: "observed" | "committed" | "confirmed" | "reorged";
    readonly state?: string;
  } = {},
): ApiJobEvents["items"][number] {
  return {
    eventId,
    jobId: HASH,
    eventType: options.state === undefined ? "job_discovered" : `transaction_${options.state}`,
    category: options.state === undefined ? "lifecycle" : "transaction",
    source: options.confidence === "observed" ? "operational" : "indexed",
    confidence: options.confidence ?? "committed",
    block: null,
    attempt:
      options.state === undefined
        ? null
        : {
            id: "11111111-1111-4111-8111-111111111111",
            operation: "execute",
            state: options.state,
            transactionHash: HASH,
            committedBlockNumber: null,
            receipt: null,
          },
    replacement: null,
    details: {},
    occurredAt: "2026-09-24T10:00:00.000Z",
    recordedAt: "2026-09-24T10:00:00.000Z",
    orphanedAt: null,
  };
}

test("detail presentation covers waiting, eligible, completed, and funding states", () => {
  assert.equal(jobDetailPresentation(job(), []).status, "waiting");
  assert.equal(
    jobDetailPresentation(
      job({
        source: { ...job().source, indexCheckpoint: { blockHash: HASH, blockNumber: "150" } },
      }),
      [],
    ).status,
    "eligible",
  );
  assert.equal(jobDetailPresentation(job({ state: "spent" }), []).status, "completed");
  assert.equal(
    jobDetailPresentation(job({ funds: { ...job().funds, remainingBudget: "0" } }), []).status,
    "needs_funding",
  );
});

test("terminal attempts, reorgs, and unsupported policies remain distinct", () => {
  for (const state of ["cancelled", "conflicted", "dropped"] as const) {
    assert.equal(jobDetailPresentation(job(), [event("2", { state })]).status, state);
  }
  assert.equal(
    jobDetailPresentation(job(), [event("3", { confidence: "reorged" })]).status,
    "reorged",
  );
  assert.equal(
    jobDetailPresentation(job({ protocol: { flags: 0, rawData: "0x", version: 2 as 1 } }), [])
      .status,
    "unsupported",
  );
  assert.equal(
    jobDetailPresentation(job({ state: "spent" }), [
      event("1", { state: "dropped" }),
      event("2", { confidence: "confirmed", state: "confirmed" }),
    ]).status,
    "completed",
  );
});

test("timeline merging is stable, ordered, and replaces duplicate observations", () => {
  const first = event("1");
  const newer = event("2", { state: "submitted" });
  const updated = { ...newer, confidence: "confirmed" as const };
  const merged = mergeTimeline([newer, first], [updated]);
  assert.deepEqual(
    merged.map(({ eventId }) => eventId),
    ["1", "2"],
  );
  assert.equal(merged[1]?.confidence, "confirmed");
  assert.equal(eventLabel("transaction_recovery_required"), "Transaction Recovery Required");
});
