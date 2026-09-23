import assert from "node:assert/strict";
import test from "node:test";

import type { Queue, Worker } from "bullmq";

import { AUTOMATA_QUEUES } from "@ckb-automata/telemetry";

import {
  DeadLetterOperations,
  parseDeadLetterPayload,
  type DeadLetterAction,
  type DeadLetterCloseDecision,
  type DeadLetterRecord,
  type DeadLetterReplayDecision,
  type DeadLetterStore,
} from "./dead-letter.ts";
import {
  DurableQueueRegistry,
  forwardTerminalFailures,
  stableQueueJobId,
  type DeadLetterPayload,
} from "./queues.ts";

const FAILED_AT = new Date("2026-09-23T15:00:00.000Z");

function payload(): DeadLetterPayload {
  return Object.freeze({
    sourceQueue: "evaluate",
    sourceJobId: stableQueueJobId("evaluate", "original"),
    sourceOperation: "evaluate-job",
    sourceEnvelope: Object.freeze({
      schemaVersion: 1,
      trace: Object.freeze({}),
      payload: Object.freeze({ jobId: "job-1", sequence: "0", wakeSequence: 0 }),
    }),
    failureCode: "EXECUTOR_RETRY_EXHAUSTED",
    attempts: 8,
    failedAt: FAILED_AT.toISOString(),
  });
}

class MemoryStore implements DeadLetterStore {
  actions: DeadLetterAction[] = [];
  resolvedAt: Date | undefined;
  dispatchedAt: Date | undefined;

  #record(): DeadLetterRecord {
    return Object.freeze({
      id: "1",
      queue: "evaluate",
      jobKey: payload().sourceJobId,
      reason: payload().failureCode,
      payload: payload(),
      attempts: 8,
      failedAt: FAILED_AT,
      ...(this.resolvedAt === undefined ? {} : { resolvedAt: this.resolvedAt }),
      createdAt: FAILED_AT,
      actions: Object.freeze([...this.actions]),
    });
  }

  async persist() {
    return this.#record();
  }

  async inspect(_id: string, operator: string) {
    this.actions.push({
      id: String(this.actions.length + 1),
      action: "inspect",
      operator,
      createdAt: FAILED_AT,
    });
    return this.#record();
  }

  async beginReplay(
    _id: string,
    operator: string,
    reason: string,
    replayJobId: string,
  ): Promise<DeadLetterReplayDecision> {
    const existing = this.actions.find((entry) => entry.action === "replay");
    if (existing) {
      return {
        record: this.#record(),
        replayJobId: existing.replayJobId!,
        idempotent: true,
        ...(this.dispatchedAt === undefined ? {} : { dispatchedAt: this.dispatchedAt }),
      };
    }
    if (this.resolvedAt !== undefined)
      throw new Error("closed dead-letter work cannot be replayed");
    this.resolvedAt = new Date("2026-09-23T15:01:00.000Z");
    this.actions.push({
      id: String(this.actions.length + 1),
      action: "replay",
      operator,
      reason,
      replayJobId,
      createdAt: this.resolvedAt,
    });
    return { record: this.#record(), replayJobId, idempotent: false };
  }

  async markReplayDispatched() {
    this.dispatchedAt = new Date("2026-09-23T15:01:01.000Z");
    const index = this.actions.findIndex((entry) => entry.action === "replay");
    const replay = this.actions[index];
    if (replay) this.actions[index] = { ...replay, dispatchedAt: this.dispatchedAt };
    return this.dispatchedAt;
  }

  async close(_id: string, operator: string, reason: string): Promise<DeadLetterCloseDecision> {
    const existing = this.actions.find((entry) => entry.action === "close");
    if (existing) return { record: this.#record(), idempotent: true };
    if (this.actions.some((entry) => entry.action === "replay"))
      throw new Error("already replayed");
    this.resolvedAt = new Date("2026-09-23T15:01:00.000Z");
    this.actions.push({
      id: String(this.actions.length + 1),
      action: "close",
      operator,
      reason,
      createdAt: this.resolvedAt,
    });
    return { record: this.#record(), idempotent: false };
  }
}

function registryFixture() {
  const additions = new Map<
    string,
    { readonly name: string; readonly data: unknown; readonly id: string }[]
  >();
  const queues = AUTOMATA_QUEUES.map((name) => {
    additions.set(name, []);
    return {
      name,
      async add(operation: string, data: unknown, options: { jobId: string }) {
        additions.get(name)!.push({ name: operation, data, id: options.jobId });
        return { id: options.jobId, data };
      },
    } as unknown as Queue;
  });
  return { registry: new DurableQueueRegistry(queues), additions };
}

test("dead-letter replay is stable, reasoned, and audited once", async () => {
  const store = new MemoryStore();
  const { registry, additions } = registryFixture();
  const operations = new DeadLetterOperations(store, registry);
  const first = await operations.replay("1", "operator@example.test", "RPC outage has recovered");
  const second = await operations.replay("1", "operator@example.test", "RPC outage has recovered");
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(first.replayJobId, second.replayJobId);
  assert.deepEqual(
    additions.get("evaluate")?.map(({ id }) => id),
    [first.replayJobId],
  );
  assert.equal(store.actions.filter(({ action }) => action === "replay").length, 1);
  assert.equal(store.actions.filter(({ action }) => action === "inspect").length, 2);
  await assert.rejects(operations.replay("1", "operator@example.test", "short"), /8 to 512/);
});

test("closing failed work is idempotent and prevents replay", async () => {
  const store = new MemoryStore();
  const { registry } = registryFixture();
  const operations = new DeadLetterOperations(store, registry);
  const first = await operations.close("1", "operator@example.test", "Known invalid fixture");
  const second = await operations.close("1", "operator@example.test", "Known invalid fixture");
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  await assert.rejects(
    operations.replay("1", "operator@example.test", "Retry after closure"),
    /cannot be replayed/,
  );
});

test("only exhausted jobs are forwarded with their complete durable envelope", async () => {
  const { registry, additions } = registryFixture();
  let failedHandler: ((job: unknown, error: Error) => void) | undefined;
  const worker = {
    on(event: string, handler: (job: unknown, error: Error) => void) {
      if (event === "failed") failedHandler = handler;
      return this;
    },
  } as unknown as Pick<Worker, "on">;
  const errors: unknown[] = [];
  forwardTerminalFailures(worker, "evaluate", registry, {
    error(_event, _message, fields) {
      errors.push(fields);
    },
  });
  assert.ok(failedHandler);
  const job = {
    id: payload().sourceJobId,
    name: payload().sourceOperation,
    data: payload().sourceEnvelope,
    attemptsMade: 7,
    opts: { attempts: 8 },
  };
  failedHandler(job, new Error("temporary"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(additions.get("dead-letter")?.length, 0);

  failedHandler({ ...job, attemptsMade: 8 }, new Error("exhausted"));
  await new Promise((resolve) => setImmediate(resolve));
  const forwarded = additions.get("dead-letter")?.[0];
  assert.ok(forwarded);
  assert.equal((forwarded.data as { payload: DeadLetterPayload }).payload.attempts, 8);
  assert.deepEqual(
    (forwarded.data as { payload: DeadLetterPayload }).payload.sourceEnvelope,
    job.data,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(parseDeadLetterPayload(payload()), payload());
  assert.throws(
    () => parseDeadLetterPayload({ ...payload(), failedAt: "not-a-timestamp" }),
    /dead-letter payload is invalid/,
  );
  assert.throws(
    () => parseDeadLetterPayload({ ...payload(), sourceQueue: "build" }),
    /dead-letter payload is invalid/,
  );
});
