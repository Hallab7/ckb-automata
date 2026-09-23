import assert from "node:assert/strict";
import test from "node:test";

import type { Queue } from "bullmq";

import { AUTOMATA_QUEUES } from "@ckb-automata/telemetry";

import {
  MAX_QUEUE_DELAY_MS,
  QUEUE_POLICIES,
  DurableQueueRegistry,
  parseRedisConnection,
  queueRegistrationOptions,
  stableQueueJobId,
} from "./queues.ts";

function queueFixture(name: string) {
  const additions: { readonly name: string; readonly data: unknown; readonly options: unknown }[] =
    [];
  let readinessChecks = 0;
  const queue = {
    name,
    async waitUntilReady() {
      readinessChecks += 1;
    },
    async add(jobName: string, data: unknown, options: unknown) {
      additions.push({ name: jobName, data, options });
      return { id: (options as { jobId: string }).jobId, data };
    },
  } as unknown as Queue;
  return { queue, additions, readinessChecks: () => readinessChecks };
}

function registryFixture() {
  const fixtures = AUTOMATA_QUEUES.map((name) => queueFixture(name));
  return {
    registry: new DurableQueueRegistry(fixtures.map(({ queue }) => queue)),
    fixtures,
  };
}

test("every durable queue has bounded retry and retention policy", () => {
  assert.deepEqual(
    queueRegistrationOptions().map(({ name }) => name),
    AUTOMATA_QUEUES,
  );
  for (const queue of AUTOMATA_QUEUES) {
    const policy = QUEUE_POLICIES[queue];
    assert.equal(Number.isSafeInteger(policy.attempts) && policy.attempts >= 1, true);
    assert.equal(policy.backoff.delay > 0, true);
    assert.equal(policy.backoff.jitter > 0 && policy.backoff.jitter <= 1, true);
    assert.equal(
      policy.backoff.delay * 2 ** Math.max(0, policy.attempts - 1) <= MAX_QUEUE_DELAY_MS,
      true,
    );
    assert.equal(policy.removeOnComplete.age > 0, true);
    assert.equal(policy.removeOnComplete.count > 0, true);
    assert.equal(policy.removeOnFail.age > policy.removeOnComplete.age, true);
    assert.equal(policy.removeOnFail.count >= policy.removeOnComplete.count, true);
  }
  assert.equal(QUEUE_POLICIES["dead-letter"].attempts, 12);
});

test("stable IDs bind both queue and idempotency key without reserved separators", () => {
  const first = stableQueueJobId("evaluate", "job/sequence/4");
  assert.equal(first, stableQueueJobId("evaluate", "job/sequence/4"));
  assert.notEqual(first, stableQueueJobId("build", "job/sequence/4"));
  assert.notEqual(first, stableQueueJobId("evaluate", "job/sequence/5"));
  assert.match(first, /^automata-evaluate-[0-9a-f]{64}$/);
  assert.equal(first.includes(":"), false);
  assert.throws(() => stableQueueJobId("evaluate", ""));
});

test("Redis URLs are normalized without weakening retry durability", () => {
  assert.deepEqual(parseRedisConnection("redis://worker:secret@127.0.0.1:6381/4"), {
    host: "127.0.0.1",
    port: 6381,
    db: 4,
    maxRetriesPerRequest: null,
    username: "worker",
    password: "secret",
  });
  assert.deepEqual(parseRedisConnection("rediss://cache.example"), {
    host: "cache.example",
    port: 6380,
    db: 0,
    maxRetriesPerRequest: null,
    tls: {},
  });
  assert.throws(() => parseRedisConnection("http://127.0.0.1"));
  assert.throws(() => parseRedisConnection("redis://127.0.0.1/999"));
});

test("registry pings every queue and applies stable IDs and delay bounds", async () => {
  const { registry, fixtures } = registryFixture();
  await registry.ready();
  assert.equal(
    fixtures.every((fixture) => fixture.readinessChecks() === 1),
    true,
  );
  const job = await registry.enqueue(
    "evaluate",
    "evaluate-job",
    "job-4",
    { jobId: "job-4" },
    {
      delay: 250,
    },
  );
  const evaluate = fixtures.find(({ queue }) => queue.name === "evaluate");
  assert.ok(evaluate);
  assert.equal(job.id, stableQueueJobId("evaluate", "job-4"));
  assert.deepEqual(evaluate.additions[0], {
    name: "evaluate-job",
    data: { schemaVersion: 1, trace: {}, payload: { jobId: "job-4" } },
    options: { jobId: stableQueueJobId("evaluate", "job-4"), delay: 250 },
  });
  assert.throws(() =>
    registry.enqueue(
      "evaluate",
      "evaluate-job",
      "late",
      {},
      {
        delay: MAX_QUEUE_DELAY_MS + 1,
      },
    ),
  );
});

test("registry readiness fails within its bounded startup deadline", async () => {
  const queues = AUTOMATA_QUEUES.map(
    (name) =>
      ({
        name,
        async waitUntilReady() {
          await new Promise(() => undefined);
        },
      }) as unknown as Queue,
  );
  const registry = new DurableQueueRegistry(queues, undefined, { readinessTimeoutMs: 10 });
  await assert.rejects(registry.ready(), /timed out/);
});

test("terminal failures are copied to the retained dead-letter queue", async () => {
  const { registry, fixtures } = registryFixture();
  const sourceJobId = stableQueueJobId("submit", "job-9");
  const failedAt = new Date("2026-09-23T15:00:00.000Z");
  const sourceJob = {
    id: sourceJobId,
    name: "submit-transaction",
    data: { schemaVersion: 1 as const, trace: {}, payload: { attemptId: "attempt-9" } },
    attemptsMade: 3,
  };
  await registry.deadLetter("submit", sourceJob, "SUBMISSION_REJECTED", failedAt);
  const deadLetter = fixtures.find(({ queue }) => queue.name === "dead-letter");
  assert.ok(deadLetter);
  assert.deepEqual(deadLetter.additions[0], {
    name: "terminal-failure",
    data: {
      schemaVersion: 1,
      trace: {},
      payload: {
        sourceQueue: "submit",
        sourceJobId,
        sourceOperation: "submit-transaction",
        sourceEnvelope: sourceJob.data,
        failureCode: "SUBMISSION_REJECTED",
        attempts: 3,
        failedAt: failedAt.toISOString(),
      },
    },
    options: {
      jobId: stableQueueJobId("dead-letter", `submit/${sourceJobId}/SUBMISSION_REJECTED`),
      delay: 0,
    },
  });
  assert.throws(() => registry.deadLetter("submit", sourceJob, "raw message"));
});
