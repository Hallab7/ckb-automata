import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { Worker } from "bullmq";

import { parseHash32 } from "@ckb-automata/core";
import { AUTOMATA_QUEUES } from "@ckb-automata/telemetry";

import { createExecutorApplication } from "../src/bootstrap.ts";
import { QUEUE_POLICIES, DurableQueueRegistry, parseRedisConnection } from "../src/queues.ts";

const redisUrl = process.env["AUTOMATA_INTEGRATION_REDIS_URL"];
if (!redisUrl) throw new Error("AUTOMATA_INTEGRATION_REDIS_URL is required");

const genesisHash = parseHash32(`0x${"1".repeat(64)}`);

function environment() {
  return {
    AUTOMATA_PROFILE: "test",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: genesisHash,
    CKB_RPC_URL: "http://127.0.0.1:1",
    CKB_INDEXER_URL: "http://127.0.0.1:1",
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
    REDIS_URL: redisUrl,
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

function chainFixture() {
  return {
    async getGenesisHash() {
      return genesisHash;
    },
    async dryRun() {
      throw new Error("dry run is disabled in the queue integration test");
    },
    async getTipHeader() {
      throw new Error("chain reads are disabled in the queue integration test");
    },
    async getCellLive() {
      throw new Error("chain reads are disabled in the queue integration test");
    },
    async findCellsPaged() {
      throw new Error("chain reads are disabled in the queue integration test");
    },
    async getTransactionStatus() {
      throw new Error("chain reads are disabled in the queue integration test");
    },
    async close() {},
  };
}

async function openExecutor(prefix) {
  return createExecutorApplication(environment(), {
    createChainClient: chainFixture,
    enableEligibilityWorkers: false,
    queuePrefix: prefix,
    writer: () => undefined,
  });
}

async function waitForState(job, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await job.getState()) === expected) return;
    await setTimeout(25);
  }
  assert.fail(`job ${job.id} did not reach ${expected}`);
}

test(
  "pending queue work survives an executor Redis-client restart",
  { timeout: 30_000 },
  async () => {
    const prefix = `ckb-automata-it-${randomBytes(6).toString("hex")}`;
    let first;
    let second;
    let worker;
    try {
      first = await openExecutor(prefix);
      const firstRegistry = first.app.get(DurableQueueRegistry);
      const queued = await firstRegistry.enqueue("evaluate", "evaluate-job", "restart-proof-job", {
        jobId: "restart-proof-job",
      });
      const duplicate = await firstRegistry.enqueue(
        "evaluate",
        "evaluate-job",
        "restart-proof-job",
        { jobId: "restart-proof-job" },
      );
      assert.equal(duplicate.id, queued.id);
      assert.deepEqual(firstRegistry.queue("evaluate").defaultJobOptions, QUEUE_POLICIES.evaluate);
      await first.app.close();
      first = undefined;

      second = await openExecutor(prefix);
      const secondRegistry = second.app.get(DurableQueueRegistry);
      const recovered = await secondRegistry.queue("evaluate").getJob(queued.id);
      assert.ok(recovered);
      assert.equal(await recovered.getState(), "waiting");

      worker = new Worker("evaluate", async (job) => ({ recovered: job.data.payload.jobId }), {
        connection: parseRedisConnection(redisUrl),
        prefix,
      });
      await worker.waitUntilReady();
      await waitForState(recovered, "completed");
      const completed = await secondRegistry.queue("evaluate").getJob(queued.id);
      assert.ok(completed);
      assert.deepEqual(completed.returnvalue, { recovered: "restart-proof-job" });
    } finally {
      if (worker) await worker.close();
      if (first) await first.app.close();
      if (second) {
        const registry = second.app.get(DurableQueueRegistry);
        await Promise.all(
          AUTOMATA_QUEUES.map((name) => registry.queue(name).obliterate({ force: true })),
        );
        await second.app.close();
      }
    }
  },
);
