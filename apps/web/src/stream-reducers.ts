import type { ApiTransactionProgress } from "@ckb-automata/api-client";

import { mergeTimeline, type DetailEvent } from "./detail/job-detail-model.ts";
import {
  parseTransactionProgress,
  sameTransactionProgress,
} from "./setup/transaction-progress-model.ts";

export type StreamReduction<T> = Readonly<{
  kind: "accepted" | "ignored" | "invalid";
  value: T;
}>;

const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const EVENT_CATEGORIES = new Set([
  "lifecycle",
  "execution",
  "transaction",
  "notification",
  "operation",
]);
const EVENT_CONFIDENCE = new Set(["observed", "committed", "confirmed", "reorged"]);
const EVENT_SOURCES = new Set(["indexed", "operational"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validBlock(value: unknown): boolean {
  if (value === null) return true;
  const block = record(value);
  return (
    block !== undefined &&
    typeof block["number"] === "string" &&
    DECIMAL_PATTERN.test(block["number"]) &&
    typeof block["hash"] === "string" &&
    HASH_PATTERN.test(block["hash"]) &&
    typeof block["transactionHash"] === "string" &&
    HASH_PATTERN.test(block["transactionHash"]) &&
    (block["transactionIndex"] === null ||
      (typeof block["transactionIndex"] === "string" &&
        DECIMAL_PATTERN.test(block["transactionIndex"])))
  );
}

function validAttempt(value: unknown): boolean {
  if (value === null) return true;
  const attempt = record(value);
  return (
    attempt !== undefined &&
    typeof attempt["id"] === "string" &&
    typeof attempt["operation"] === "string" &&
    typeof attempt["state"] === "string" &&
    (attempt["transactionHash"] === null ||
      (typeof attempt["transactionHash"] === "string" &&
        HASH_PATTERN.test(attempt["transactionHash"]))) &&
    (attempt["committedBlockNumber"] === null ||
      (typeof attempt["committedBlockNumber"] === "string" &&
        DECIMAL_PATTERN.test(attempt["committedBlockNumber"]))) &&
    (attempt["receipt"] === null || record(attempt["receipt"]) !== undefined)
  );
}

function validReplacement(value: unknown): boolean {
  if (value === null) return true;
  const replacement = record(value);
  return (
    replacement !== undefined &&
    typeof replacement["eventId"] === "string" &&
    DECIMAL_PATTERN.test(replacement["eventId"]) &&
    typeof replacement["eventType"] === "string" &&
    typeof replacement["transactionHash"] === "string" &&
    HASH_PATTERN.test(replacement["transactionHash"]) &&
    replacement["block"] !== null &&
    validBlock(replacement["block"])
  );
}

export function decodeDetailStreamEvent(
  serialized: string,
  expectedJobId: string,
): StreamReduction<DetailEvent | undefined> {
  try {
    const parsed = record(JSON.parse(serialized));
    if (
      parsed === undefined ||
      typeof parsed["eventId"] !== "string" ||
      !DECIMAL_PATTERN.test(parsed["eventId"]) ||
      typeof parsed["jobId"] !== "string" ||
      !HASH_PATTERN.test(parsed["jobId"]) ||
      typeof parsed["eventType"] !== "string" ||
      !EVENT_CATEGORIES.has(String(parsed["category"])) ||
      !EVENT_SOURCES.has(String(parsed["source"])) ||
      !EVENT_CONFIDENCE.has(String(parsed["confidence"])) ||
      !validBlock(parsed["block"]) ||
      !validAttempt(parsed["attempt"]) ||
      !validReplacement(parsed["replacement"]) ||
      record(parsed["details"]) === undefined ||
      !canonicalDate(parsed["occurredAt"]) ||
      !canonicalDate(parsed["recordedAt"]) ||
      !(parsed["orphanedAt"] === null || canonicalDate(parsed["orphanedAt"]))
    ) {
      return { kind: "invalid", value: undefined };
    }
    if (parsed["jobId"] !== expectedJobId) return { kind: "ignored", value: undefined };
    return { kind: "accepted", value: parsed as unknown as DetailEvent };
  } catch {
    return { kind: "invalid", value: undefined };
  }
}

export function reduceDetailStreamEvent(
  current: readonly DetailEvent[],
  serialized: string,
  expectedJobId: string,
): StreamReduction<readonly DetailEvent[]> {
  const decoded = decodeDetailStreamEvent(serialized, expectedJobId);
  if (decoded.kind !== "accepted" || decoded.value === undefined) {
    return { kind: decoded.kind, value: current };
  }
  try {
    return { kind: "accepted", value: mergeTimeline(current, [decoded.value]) };
  } catch {
    return { kind: "invalid", value: current };
  }
}

export function reduceTransactionProgress(
  current: ApiTransactionProgress,
  incoming: unknown,
  expectedTransactionHash: string,
): StreamReduction<ApiTransactionProgress> {
  const next = parseTransactionProgress(incoming);
  if (next === undefined) return { kind: "invalid", value: current };
  if (next.transactionHash !== expectedTransactionHash || sameTransactionProgress(current, next)) {
    return { kind: "ignored", value: current };
  }
  return { kind: "accepted", value: next };
}

export function reduceTransactionProgressStream(
  current: ApiTransactionProgress,
  serialized: string,
  expectedTransactionHash: string,
): StreamReduction<ApiTransactionProgress> {
  try {
    return reduceTransactionProgress(current, JSON.parse(serialized), expectedTransactionHash);
  } catch {
    return { kind: "invalid", value: current };
  }
}
