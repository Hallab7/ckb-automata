import assert from "node:assert/strict";
import test from "node:test";

import { BadRequestException, type MessageEvent } from "@nestjs/common";

import { JobEventStreamService, type JobEventReadModel, type JobEventTimeline } from "./events.ts";

const jobId = `0x${"01".repeat(32)}`;

function event(eventId: string, category: JobEventReadModel["category"]): JobEventReadModel {
  return {
    eventId,
    jobId,
    eventType: category === "transaction" ? "transaction_submitted" : "job_discovered",
    category,
    source: category === "transaction" ? "operational" : "indexed",
    confidence: category === "transaction" ? "observed" : "committed",
    block: null,
    attempt: null,
    replacement: null,
    details: {},
    occurredAt: "2026-09-22T00:00:00.000Z",
    recordedAt: "2026-09-22T00:00:00.000Z",
    orphanedAt: null,
  };
}

function reader(source: JobEventReadModel[]) {
  return {
    async timeline(
      _jobId: string,
      _query: Readonly<Record<string, unknown>>,
      options?: { readonly afterEventId?: string },
    ): Promise<JobEventTimeline> {
      const after = BigInt(options?.afterEventId ?? "0");
      return {
        jobId,
        items: source.filter((item) => BigInt(item.eventId) > after),
        page: { limit: 100, nextCursor: null },
        indexCheckpoint: null,
      };
    },
  };
}

function collectEventIds(
  stream: ReturnType<JobEventStreamService["stream"]>,
  count: number,
): Promise<{ readonly frames: MessageEvent[]; readonly close: () => void }> {
  return new Promise((resolve, reject) => {
    const frames: MessageEvent[] = [];
    const subscription = stream.subscribe({
      next: (frame) => {
        if (frame.id !== undefined) frames.push(frame);
        if (frames.length === count) resolve({ frames, close: () => subscription.unsubscribe() });
      },
      error: reject,
    });
  });
}

test("reconnect delivers each missed event once by event ID", async () => {
  const source = [event("1", "lifecycle"), event("2", "transaction")];
  const service = new JobEventStreamService(reader(source), { heartbeatMs: 100, pollMs: 5 });
  const initial = await collectEventIds(service.stream(jobId, undefined, undefined), 2);
  initial.close();
  assert.deepEqual(
    initial.frames.map(({ id }) => id),
    ["1", "2"],
  );
  assert.deepEqual(
    initial.frames.map(({ type }) => type),
    ["job-event", "transaction-event"],
  );

  source.push(event("3", "lifecycle"));
  const resumed = await collectEventIds(service.stream(jobId, "2", undefined), 1);
  resumed.close();
  assert.deepEqual(
    resumed.frames.map(({ id }) => id),
    ["3"],
  );
});

test("heartbeat frames never advance the reconnect cursor", async () => {
  const service = new JobEventStreamService(reader([]), {
    heartbeatMs: 5,
    now: () => new Date("2026-09-22T12:00:00.000Z"),
    pollMs: 100,
  });
  const heartbeat = await new Promise<MessageEvent>((resolve, reject) => {
    const subscription = service.stream(jobId, undefined, undefined).subscribe({
      next: (frame) => {
        if (frame.comment !== undefined) {
          subscription.unsubscribe();
          resolve(frame);
        }
      },
      error: reject,
    });
  });
  assert.equal(heartbeat.id, undefined);
  assert.equal(heartbeat.comment, "heartbeat 2026-09-22T12:00:00.000Z");
});

test("reconnect cursors are canonical and unambiguous", () => {
  const service = new JobEventStreamService(reader([]));
  assert.throws(
    () => service.stream(jobId, "01", undefined),
    (error: unknown) => error instanceof BadRequestException,
  );
  assert.throws(
    () => service.stream(jobId, "1", "2"),
    (error: unknown) => error instanceof BadRequestException,
  );
});

test("an already disconnected request completes without polling", async () => {
  let reads = 0;
  const service = new JobEventStreamService(
    {
      async timeline(): Promise<JobEventTimeline> {
        reads += 1;
        throw new Error("must not poll");
      },
    },
    { heartbeatMs: 5, pollMs: 5 },
  );
  const controller = new AbortController();
  controller.abort();

  await new Promise<void>((resolve, reject) => {
    service.stream(jobId, undefined, undefined, controller.signal).subscribe({
      complete: resolve,
      error: reject,
    });
  });
  assert.equal(reads, 0);
});
