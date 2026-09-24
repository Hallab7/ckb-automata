"use client";

import { useState } from "react";

import type { ApiActivity } from "@ckb-automata/api-client";

import type { ActivityOutcomeFilter } from "./activity-model.ts";
import { ActivityView, type ActivitySourceFilter } from "./activity-view.tsx";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const HASH_C = `0x${"33".repeat(32)}`;

function event(
  eventId: string,
  jobId: string,
  state: string,
  source: "indexed" | "operational",
  operation: "cancel" | "execute" | "recover" = "execute",
): ApiActivity["items"][number] {
  const indexed = source === "indexed";
  return {
    attempt: {
      committedBlockNumber: indexed ? "15842900" : null,
      id: `${eventId.padStart(8, "0")}-1111-4111-8111-111111111111`,
      operation,
      receipt:
        state === "confirmed"
          ? {
              createdAt: "2026-09-24T10:00:01.000Z",
              executorLockHash: HASH_C,
              id: "22222222-2222-4222-8222-222222222222",
              keyId: `ckb-secp256k1:${"44".repeat(20)}`,
              payload: { outcome: { state } },
              signature: `0x${"55".repeat(64)}`,
            }
          : null,
      state,
      transactionHash: HASH_B,
    },
    block: indexed
      ? { hash: HASH_C, number: "15842900", transactionHash: HASH_B, transactionIndex: "0" }
      : null,
    category: "transaction",
    confidence: state === "reorged" ? "reorged" : indexed ? "confirmed" : "observed",
    details: { attemptId: `${eventId.padStart(8, "0")}-1111-4111-8111-111111111111` },
    eventId,
    eventType: operation === "recover" ? "job_recovery_required" : `transaction_${state}`,
    jobId,
    occurredAt: `2026-09-24T10:${eventId.padStart(2, "0")}:00.000Z`,
    orphanedAt: state === "reorged" ? "2026-09-24T11:00:00.000Z" : null,
    recordedAt: `2026-09-24T10:${eventId.padStart(2, "0")}:01.000Z`,
    replacement: null,
    source,
  };
}

const items = [
  event("17", HASH_A, "submitted", "operational"),
  event("16", HASH_A, "confirmed", "indexed"),
  event("15", HASH_A, "conflicted", "operational"),
  event("14", HASH_B, "dropped", "operational"),
  event("13", HASH_B, "reorged", "indexed"),
  event("12", HASH_C, "cancelled", "indexed", "cancel"),
  event("11", HASH_C, "recovery_required", "operational", "recover"),
] as ApiActivity["items"];

export function ActivityFixture() {
  const [source, setSource] = useState<ActivitySourceFilter>("");
  const [outcome, setOutcome] = useState<ActivityOutcomeFilter>("");
  return (
    <div className="activity-fixture">
      <ActivityView
        checkpointBlock="15842920"
        hasNextPage
        items={source === "" ? items : items.filter((item) => item.source === source)}
        loadState="ready"
        onLoadNext={() => undefined}
        onOutcomeChange={setOutcome}
        onSourceChange={setSource}
        outcomeFilter={outcome}
        sourceFilter={source}
      />
    </div>
  );
}
