import type { AutomataQueue } from "@ckb-automata/telemetry";

import type { DeadLetterPayload, QueueEnqueuer, QueueJobEnvelope } from "./queues.ts";

export type DeadLetterSourceQueue = Exclude<AutomataQueue, "dead-letter">;
export type DeadLetterActionKind = "inspect" | "replay" | "close";

export interface DeadLetterAction {
  readonly id: string;
  readonly action: DeadLetterActionKind;
  readonly operator: string;
  readonly reason?: string;
  readonly replayJobId?: string;
  readonly dispatchedAt?: Date;
  readonly createdAt: Date;
}

export interface DeadLetterRecord {
  readonly id: string;
  readonly queue: DeadLetterSourceQueue;
  readonly jobKey: string;
  readonly reason: string;
  readonly payload: DeadLetterPayload;
  readonly attempts: number;
  readonly failedAt: Date;
  readonly resolvedAt?: Date;
  readonly createdAt: Date;
  readonly actions: readonly DeadLetterAction[];
}

export interface DeadLetterReplayDecision {
  readonly record: DeadLetterRecord;
  readonly replayJobId: string;
  readonly idempotent: boolean;
  readonly dispatchedAt?: Date;
}

export interface DeadLetterCloseDecision {
  readonly record: DeadLetterRecord;
  readonly idempotent: boolean;
}

export interface DeadLetterStore {
  persist(payload: DeadLetterPayload): Promise<DeadLetterRecord>;
  inspect(id: string, operator: string): Promise<DeadLetterRecord>;
  beginReplay(id: string, operator: string, reason: string): Promise<DeadLetterReplayDecision>;
  markReplayDispatched(id: string, replayJobId: string): Promise<Date>;
  close(id: string, operator: string, reason: string): Promise<DeadLetterCloseDecision>;
}

const OPERATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{1,127}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const JOB_ID_PATTERN = /^automata-[a-z-]+-[0-9a-f]{64}$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const SOURCE_QUEUES: readonly DeadLetterSourceQueue[] = [
  "discovery",
  "evaluate",
  "build",
  "submit",
  "confirm",
  "notify",
];

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function parseDeadLetterId(value: string): string {
  if (!DECIMAL_ID_PATTERN.test(value)) throw new TypeError("dead-letter ID is invalid");
  return value;
}

export function parseDeadLetterOperator(value: string): string {
  if (!OPERATOR_PATTERN.test(value)) throw new TypeError("dead-letter operator is invalid");
  return value;
}

export function parseDeadLetterReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 8 || reason.length > 512) {
    throw new TypeError("dead-letter reason must contain 8 to 512 characters");
  }
  return reason;
}

export function parseDeadLetterPayload(value: unknown): DeadLetterPayload {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("dead-letter payload is invalid");
  }
  const payload = value as Partial<DeadLetterPayload>;
  const attempts = payload.attempts;
  if (
    !SOURCE_QUEUES.some((queue) => queue === payload.sourceQueue) ||
    typeof payload.sourceJobId !== "string" ||
    !JOB_ID_PATTERN.test(payload.sourceJobId) ||
    !payload.sourceJobId.startsWith(`automata-${payload.sourceQueue}-`) ||
    typeof payload.sourceOperation !== "string" ||
    !/^[a-z][a-z0-9.-]{0,63}$/.test(payload.sourceOperation) ||
    typeof payload.failureCode !== "string" ||
    !FAILURE_CODE_PATTERN.test(payload.failureCode) ||
    !Number.isSafeInteger(attempts) ||
    attempts === undefined ||
    attempts < 1 ||
    !isCanonicalTimestamp(payload.failedAt) ||
    typeof payload.sourceEnvelope !== "object" ||
    payload.sourceEnvelope === null ||
    payload.sourceEnvelope.schemaVersion !== 1 ||
    typeof payload.sourceEnvelope.trace !== "object" ||
    payload.sourceEnvelope.trace === null
  ) {
    throw new TypeError("dead-letter payload is invalid");
  }
  return Object.freeze({
    sourceQueue: payload.sourceQueue as DeadLetterSourceQueue,
    sourceJobId: payload.sourceJobId,
    sourceOperation: payload.sourceOperation,
    sourceEnvelope: payload.sourceEnvelope as QueueJobEnvelope<unknown>,
    failureCode: payload.failureCode,
    attempts,
    failedAt: payload.failedAt,
  });
}

export class DeadLetterOperations {
  readonly #store: DeadLetterStore;
  readonly #queues: QueueEnqueuer;

  constructor(store: DeadLetterStore, queues: QueueEnqueuer) {
    this.#store = store;
    this.#queues = queues;
  }

  inspect(id: string, operator: string): Promise<DeadLetterRecord> {
    return this.#store.inspect(parseDeadLetterId(id), parseDeadLetterOperator(operator));
  }

  async replay(id: string, operator: string, reason: string): Promise<DeadLetterReplayDecision> {
    const deadLetterId = parseDeadLetterId(id);
    const actor = parseDeadLetterOperator(operator);
    const justification = parseDeadLetterReason(reason);
    const decision = await this.#store.beginReplay(deadLetterId, actor, justification);
    if (decision.dispatchedAt !== undefined) return decision;
    const replayKey = `dead-letter/${deadLetterId}/replay`;
    const job = await this.#queues.enqueue(
      decision.record.queue,
      decision.record.payload.sourceOperation,
      replayKey,
      decision.record.payload.sourceEnvelope.payload,
    );
    if (job.id !== decision.replayJobId) {
      throw new Error("dead-letter replay queue returned an unexpected job ID");
    }
    const dispatchedAt = await this.#store.markReplayDispatched(deadLetterId, decision.replayJobId);
    return Object.freeze({ ...decision, dispatchedAt });
  }

  close(id: string, operator: string, reason: string): Promise<DeadLetterCloseDecision> {
    return this.#store.close(
      parseDeadLetterId(id),
      parseDeadLetterOperator(operator),
      parseDeadLetterReason(reason),
    );
  }
}
