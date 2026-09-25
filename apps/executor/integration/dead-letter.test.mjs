import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { Queue, UnrecoverableError, Worker } from "bullmq";
import postgres from "postgres";

import { AUTOMATA_QUEUES } from "@ckb-automata/telemetry";

import { migrateDatabase } from "../../api/src/database/migrator.ts";
import { PostgresDeadLetterStore } from "../src/dead-letter-store.ts";
import { DeadLetterOperations, parseDeadLetterPayload } from "../src/dead-letter.ts";
import {
  DurableQueueRegistry,
  forwardTerminalFailures,
  parseRedisConnection,
  stableQueueJobId,
} from "../src/queues.ts";

const databaseUrl = process.env["AUTOMATA_INTEGRATION_DATABASE_URL"];
const redisUrl = process.env["AUTOMATA_INTEGRATION_REDIS_URL"];
if (!databaseUrl || !redisUrl) {
  throw new Error(
    "AUTOMATA_INTEGRATION_DATABASE_URL and AUTOMATA_INTEGRATION_REDIS_URL are required",
  );
}

const now = new Date(Date.now() + 60_000);

async function createDatabase() {
  const name = `automata_dead_letter_${randomBytes(6).toString("hex")}`;
  if (!/^automata_dead_letter_[0-9a-f]{12}$/.test(name)) {
    throw new Error("refusing to manage an unexpected integration database");
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${name}`;
  const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await migrateDatabase({ connectionString: testUrl.href });
  return { admin, name, url: testUrl.href };
}

function failedWork(key) {
  return {
    sourceQueue: "evaluate",
    sourceJobId: stableQueueJobId("evaluate", key),
    sourceOperation: "evaluate-job",
    sourceEnvelope: {
      schemaVersion: 1,
      trace: {},
      payload: { jobId: `job-${key}`, sequence: "0", wakeSequence: 0 },
    },
    failureCode: "EXECUTOR_RETRY_EXHAUSTED",
    attempts: 8,
    failedAt: now.toISOString(),
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await setTimeout(25);
  }
  assert.fail("condition was not reached");
}

test("dead-letter replay is idempotent and fully audited", async () => {
  const database = await createDatabase();
  const prefix = `ckb-automata-dl-${randomBytes(6).toString("hex")}`;
  const connection = parseRedisConnection(redisUrl);
  const queues = AUTOMATA_QUEUES.map((name) => new Queue(name, { connection, prefix }));
  const registry = new DurableQueueRegistry(queues);
  const store = new PostgresDeadLetterStore(database.url, () => now);
  let failingWorker;
  let persistenceWorker;
  try {
    const forwardingErrors = [];
    persistenceWorker = new Worker(
      "dead-letter",
      (job) => store.persist(parseDeadLetterPayload(job.data.payload)),
      { connection, prefix },
    );
    failingWorker = new Worker(
      "evaluate",
      async () => {
        const error = new UnrecoverableError("EXECUTOR_RETRY_EXHAUSTED");
        Object.defineProperty(error, "cause", {
          value: Object.assign(new Error("temporary dependency exhausted"), {
            code: "EXECUTOR_BUILD_FAILED",
          }),
        });
        throw error;
      },
      { connection, prefix },
    );
    forwardTerminalFailures(failingWorker, "evaluate", registry, {
      error(_event, _message, fields) {
        forwardingErrors.push(fields);
      },
    });
    await Promise.all([persistenceWorker.waitUntilReady(), failingWorker.waitUntilReady()]);
    await registry.enqueue(
      "evaluate",
      failedWork("original").sourceOperation,
      "original",
      failedWork("original").sourceEnvelope.payload,
    );
    const persisted = await until(async () => {
      const sql = postgres(database.url, { max: 1, onnotice: () => undefined });
      try {
        const [row] = await sql`
          SELECT id::text, payload FROM dead_letters WHERE queue = 'evaluate'
        `;
        return row;
      } finally {
        await sql.end({ timeout: 2 });
      }
    });
    assert.equal(forwardingErrors.length, 1);
    const [{ jobId, ...failure }] = forwardingErrors;
    assert.match(jobId, /^automata-evaluate-[0-9a-f]{64}$/);
    assert.deepEqual(failure, {
      queue: "evaluate",
      failureCode: "EXECUTOR_BUILD_FAILED",
      attempts: 1,
      failureName: "UnrecoverableError",
      failureMessage: "EXECUTOR_RETRY_EXHAUSTED",
    });
    await Promise.all([failingWorker.close(), persistenceWorker.close()]);
    failingWorker = undefined;
    persistenceWorker = undefined;

    const original = await store.persist(persisted.payload);
    assert.equal(original.id, persisted.id);
    const duplicate = await store.persist(persisted.payload);
    assert.equal(duplicate.id, original.id);
    await assert.rejects(
      store.persist({ ...persisted.payload, sourceOperation: "different-operation" }),
      /duplicate dead-letter evidence does not match/,
    );

    const operations = new DeadLetterOperations(store, registry);
    const inspected = await operations.inspect(original.id, "operator@example.test");
    assert.equal(inspected.actions.at(-1)?.action, "inspect");
    const first = await operations.replay(
      original.id,
      "operator@example.test",
      "Upstream RPC service has recovered",
    );
    const second = await operations.replay(
      original.id,
      "operator@example.test",
      "Upstream RPC service has recovered",
    );
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(first.replayJobId, second.replayJobId);
    const replay = await registry.queue("evaluate").getJob(first.replayJobId);
    assert.ok(replay);
    assert.equal(replay.name, "evaluate-job");
    assert.deepEqual(replay.data.payload, failedWork("original").sourceEnvelope.payload);

    const closedRecord = await store.persist(failedWork("close"));
    const closed = await operations.close(
      closedRecord.id,
      "operator@example.test",
      "Invalid fixture must remain closed",
    );
    const closedAgain = await operations.close(
      closedRecord.id,
      "operator@example.test",
      "Invalid fixture must remain closed",
    );
    assert.equal(closed.idempotent, false);
    assert.equal(closedAgain.idempotent, true);

    const sql = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      const replayActions = await sql`
        SELECT action, operator, reason, replay_job_id, dispatched_at
        FROM dead_letter_actions
        WHERE dead_letter_id = ${original.id} AND action = 'replay'
      `;
      assert.deepEqual(
        [...replayActions],
        [
          {
            action: "replay",
            operator: "operator@example.test",
            reason: "Upstream RPC service has recovered",
            replay_job_id: first.replayJobId,
            dispatched_at: now,
          },
        ],
      );
      const [counts] = await sql`
        SELECT
          count(*) FILTER (WHERE action = 'replay')::integer AS replays,
          count(*) FILTER (WHERE action = 'inspect')::integer AS inspections
        FROM dead_letter_actions
        WHERE dead_letter_id = ${original.id}
      `;
      assert.deepEqual(counts, { replays: 1, inspections: 3 });
    } finally {
      await sql.end({ timeout: 2 });
    }
  } finally {
    await Promise.all([failingWorker?.close(), persistenceWorker?.close()]);
    await Promise.all(
      queues.map(async (queue) => {
        await queue.obliterate({ force: true });
        await queue.close();
      }),
    );
    await store.closeConnection();
    await database.admin.unsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end({ timeout: 2 });
  }
});
