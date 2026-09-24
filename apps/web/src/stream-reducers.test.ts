import assert from "node:assert/strict";
import test from "node:test";

import type { ApiJobEvents, ApiTransactionProgress } from "@ckb-automata/api-client";

import {
  reduceDetailStreamEvent,
  reduceTransactionProgress,
  reduceTransactionProgressStream,
} from "./stream-reducers.ts";

const JOB_ID = `0x${"11".repeat(32)}`;
const TRANSACTION_HASH = `0x${"22".repeat(32)}`;

function detailEvent(eventId: string): ApiJobEvents["items"][number] {
  return {
    attempt: null,
    block: null,
    category: "lifecycle",
    confidence: "committed",
    details: {},
    eventId,
    eventType: "job_discovered",
    jobId: JOB_ID,
    occurredAt: "2026-09-24T10:00:00.000Z",
    orphanedAt: null,
    recordedAt: "2026-09-24T10:00:00.000Z",
    replacement: null,
    source: "indexed",
  };
}

function progress(overrides: Partial<ApiTransactionProgress> = {}): ApiTransactionProgress {
  return {
    block: null,
    confirmations: "0",
    observedAt: "2026-09-24T10:00:00.000Z",
    reason: null,
    requiredConfirmations: 3,
    state: "submitted",
    transactionHash: TRANSACTION_HASH,
    ...overrides,
  };
}

test("detail SSE reducer accepts matching events and ignores cross-job data", () => {
  const first = detailEvent("1");
  const second = detailEvent("2");
  const accepted = reduceDetailStreamEvent([first], JSON.stringify(second), JOB_ID);
  assert.equal(accepted.kind, "accepted");
  assert.deepEqual(
    accepted.value.map(({ eventId }) => eventId),
    ["1", "2"],
  );

  const ignored = reduceDetailStreamEvent(
    accepted.value,
    JSON.stringify({ ...second, eventId: "3", jobId: `0x${"33".repeat(32)}` }),
    JOB_ID,
  );
  assert.equal(ignored.kind, "ignored");
  assert.equal(ignored.value, accepted.value);
  assert.equal(reduceDetailStreamEvent(accepted.value, "{", JOB_ID).kind, "invalid");
  assert.equal(
    reduceDetailStreamEvent(accepted.value, JSON.stringify({ ...second, eventId: "01" }), JOB_ID)
      .kind,
    "invalid",
  );
  assert.equal(
    reduceDetailStreamEvent(
      accepted.value,
      JSON.stringify({ ...second, occurredAt: "not-a-date" }),
      JOB_ID,
    ).kind,
    "invalid",
  );
});

test("transaction SSE reducer rejects malformed and cross-transaction updates", () => {
  const current = progress();
  assert.equal(reduceTransactionProgressStream(current, "{", TRANSACTION_HASH).kind, "invalid");
  assert.equal(
    reduceTransactionProgress(
      current,
      { ...current, transactionHash: `0x${"44".repeat(32)}` },
      TRANSACTION_HASH,
    ).kind,
    "ignored",
  );
  assert.equal(reduceTransactionProgress(current, current, TRANSACTION_HASH).kind, "ignored");

  const committed = progress({
    block: { hash: `0x${"55".repeat(32)}`, number: "9007199254740993" },
    confirmations: "1",
    state: "committed",
  });
  const accepted = reduceTransactionProgressStream(
    current,
    JSON.stringify(committed),
    TRANSACTION_HASH,
  );
  assert.equal(accepted.kind, "accepted");
  assert.equal(accepted.value.block?.number, "9007199254740993");
  assert.equal(accepted.value.state, "committed");
});
