import assert from "node:assert/strict";
import test from "node:test";

import type { Queue, QueueOptions } from "bullmq";

import { DeadLetterReplayDispatcher } from "./dead-letter-dispatcher.ts";
import { stableQueueJobId } from "./queues.ts";

test("dead-letter replay opens only its source queue", async () => {
  const created: string[] = [];
  let ready = 0;
  let closed = 0;
  const dispatcher = new DeadLetterReplayDispatcher(
    "redis://cache.internal:6379",
    "ckb-automata-operator-a",
    (name: string, _options: QueueOptions) => {
      created.push(name);
      return {
        async waitUntilReady() {
          ready += 1;
        },
        async add(_operation: string, data: unknown, options: { jobId: string }) {
          return { id: options.jobId, data };
        },
        async close() {
          closed += 1;
        },
      } as unknown as Queue;
    },
  );

  const job = await dispatcher.enqueue("submit", "dry-run-transaction", "dead-letter/54/replay", {
    attemptId: "attempt-1",
  });
  assert.equal(job.id, stableQueueJobId("submit", "dead-letter/54/replay"));
  assert.deepEqual(created, ["submit"]);
  assert.equal(ready, 1);

  await assert.rejects(
    dispatcher.enqueue("confirm", "confirm-transaction", "dead-letter/55/replay", {}),
    /limited to one source queue/,
  );
  await dispatcher.close();
  assert.equal(closed, 1);
});

test("dead-letter inspection can avoid opening Redis", async () => {
  const dispatcher = new DeadLetterReplayDispatcher(undefined, "ckb-automata-operator-a", () => {
    throw new Error("queue should not be created");
  });
  await dispatcher.close();
  await assert.rejects(
    dispatcher.enqueue("submit", "dry-run-transaction", "dead-letter/54/replay", {}),
    /REDIS_URL is required/,
  );
});

test("dead-letter replay readiness remains bounded", async () => {
  const dispatcher = new DeadLetterReplayDispatcher(
    "redis://cache.internal:6379",
    "ckb-automata-operator-a",
    () =>
      ({
        waitUntilReady: () => new Promise(() => undefined),
        add: () => {
          throw new Error("queue should not receive work");
        },
        close: async () => undefined,
      }) as unknown as Queue,
    5,
  );
  await assert.rejects(
    dispatcher.enqueue("submit", "dry-run-transaction", "dead-letter/54/replay", {}),
    /readiness timed out/,
  );
  await dispatcher.close();
});
