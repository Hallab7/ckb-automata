import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { Queue } from "bullmq";
import postgres from "postgres";

import {
  buildRecurringCreation,
  deploymentRegistry,
  inspectJobData,
  parseHash32,
} from "@ckb-automata/core";
import { AUTOMATA_QUEUES } from "@ckb-automata/telemetry";

import { migrateDatabase } from "../../api/src/database/migrator.ts";
import { PostgresBuildAttemptStore } from "../src/build-store.ts";
import { PostgresSimulationStore } from "../src/simulation-store.ts";
import { createExecutorApplication } from "../src/bootstrap.ts";
import { DurableQueueRegistry, parseRedisConnection } from "../src/queues.ts";

const databaseUrl = process.env["AUTOMATA_INTEGRATION_DATABASE_URL"];
const redisUrl = process.env["AUTOMATA_INTEGRATION_REDIS_URL"];
if (!databaseUrl || !redisUrl) {
  throw new Error(
    "AUTOMATA_INTEGRATION_DATABASE_URL and AUTOMATA_INTEGRATION_REDIS_URL are required",
  );
}

const [genesisHash] = deploymentRegistry.genesisHashes;
assert.ok(genesisHash);
const loaded = await deploymentRegistry.load(genesisHash);
assert.equal(loaded.status, "ok");
if (loaded.status !== "ok") throw new Error("local deployment is unavailable");
const deployment = loaded.deployment;

function hash(byte) {
  return parseHash32(`0x${byte.toString(16).padStart(2, "0").repeat(32)}`);
}

async function createDatabase() {
  const name = `automata_eligibility_${randomBytes(6).toString("hex")}`;
  if (!/^automata_eligibility_[0-9a-f]{12}$/.test(name)) {
    throw new Error("refusing to manage an unexpected integration database");
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${name}`;
  const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  return { admin, name, url: testUrl.href };
}

async function seedJob(url) {
  await migrateDatabase({ connectionString: url });
  const ownerLockHash = hash(17);
  const recipientLockHash = hash(34);
  const creation = buildRecurringCreation({
    deployment,
    ownerLockHash,
    recipientLockHash,
    amount: "10000000000",
    intervalBlocks: "10",
    firstNotBefore: "100",
    totalRuns: "2",
    reward: "10000000000",
    creatorNonce: "71",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "900" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const output = creation.transaction.outputs[0];
  assert.ok(output?.type);
  const inspected = inspectJobData(creation.jobData, {
    manifest: deployment.manifest,
    expectedGenesisHash: deployment.genesisHash,
    policyScript: output.type,
  });
  assert.equal(inspected.status, "ok");
  if (inspected.status !== "ok") throw new Error("recurring fixture is invalid");
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql`
      INSERT INTO networks (
        id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
      ) VALUES (
        ${deployment.network}, ${deployment.genesisHash}, 'local',
        ${deployment.confirmation.requiredDepth}, ${deployment.manifestSha256}
      )
    `;
    await sql`
      INSERT INTO jobs (
        network_id, job_id, outpoint_tx_hash, outpoint_index, sequence,
        owner_lock_hash, policy_script_hash, policy_kind, state, capacity,
        data, block_number, block_hash, transaction_index
      ) VALUES (
        ${deployment.network}, ${inspected.job.jobId}, ${hash(71)}, '0',
        ${inspected.job.sequence.toString()}, ${inspected.job.cancelLockHash},
        ${inspected.job.policyScriptHash}, 'recurring', 'live', ${BigInt(output.capacity).toString()},
        ${Buffer.from(creation.jobData.slice(2), "hex")}, '90', ${hash(70)}, '0'
      )
    `;
  } finally {
    await sql.end({ timeout: 2 });
  }
  return { jobId: inspected.job.jobId, sequence: inspected.job.sequence.toString() };
}

function environment(url) {
  return {
    AUTOMATA_PROFILE: "test",
    CKB_NETWORK: deployment.network,
    CKB_GENESIS_HASH: deployment.genesisHash,
    CKB_RPC_URL: "http://127.0.0.1:1",
    CKB_INDEXER_URL: "http://127.0.0.1:1",
    DATABASE_URL: url,
    REDIS_URL: redisUrl,
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

function chainFixture(state) {
  return {
    async getGenesisHash() {
      return deployment.genesisHash;
    },
    async dryRun() {
      throw new Error("simulation worker is not configured by this test");
    },
    async getTipHeader() {
      return {
        hash: hash(Number(state.tip)),
        number: `0x${state.tip.toString(16)}`,
        epoch: "0x0",
        timestamp: "0x0",
      };
    },
    async getCellLive() {
      throw new Error("build worker is not configured by this test");
    },
    async findCellsPaged() {
      throw new Error("build worker is not configured by this test");
    },
    async getTransactionStatus() {
      throw new Error("build worker is not configured by this test");
    },
    async close() {},
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await setTimeout(25);
  }
  assert.fail("condition was not reached");
}

async function clearQueues(prefix) {
  const connection = parseRedisConnection(redisUrl);
  await Promise.all(
    AUTOMATA_QUEUES.map(async (name) => {
      const queue = new Queue(name, { connection, prefix });
      try {
        await queue.obliterate({ force: true });
      } finally {
        await queue.close();
      }
    }),
  );
}

test(
  "only a current chain lower bound promotes a live job to build",
  { timeout: 30_000 },
  async () => {
    const database = await createDatabase();
    const prefix = `ckb-automata-elig-${randomBytes(6).toString("hex")}`;
    const state = { tip: 90n };
    let app;
    try {
      const job = await seedJob(database.url);
      app = await createExecutorApplication(environment(database.url), {
        createChainClient: () => chainFixture(state),
        queuePrefix: prefix,
        writer: () => undefined,
      });
      const queues = app.app.get(DurableQueueRegistry);
      await until(async () => (await queues.queue("evaluate").getCompletedCount()) >= 1);
      assert.equal(await queues.queue("build").getWaitingCount(), 0);
      assert.equal(await queues.queue("build").getCompletedCount(), 0);

      state.tip = 100n;
      await queues.enqueue("evaluate", "evaluate-job", `${job.jobId}/${job.sequence}/tip-100`, {
        ...job,
        wakeSequence: 999,
      });
      await until(async () => (await queues.queue("build").getWaitingCount()) === 1);
      const [ready] = await queues.queue("build").getWaiting();
      assert.equal(ready?.data.payload.jobId, job.jobId);
      assert.equal(ready?.data.payload.evaluatedAt.blockNumber, "100");
    } finally {
      if (app) await app.app.close();
      await clearQueues(prefix);
      await database.admin.unsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
      await database.admin.end({ timeout: 2 });
    }
  },
);

test("concurrent build deliveries share one durable operational attempt", async () => {
  const database = await createDatabase();
  let store;
  let simulationStore;
  try {
    const job = await seedJob(database.url);
    store = new PostgresBuildAttemptStore(database.url, deployment.network);
    const payload = {
      ...job,
      adapterId: "recurring-v1",
      evaluatedAt: { blockHash: hash(90), blockNumber: "90" },
    };
    const claims = await Promise.all([store.claim(payload), store.claim(payload)]);
    const claimed = claims.find((result) => result.status === "claimed");
    const duplicate = claims.find((result) => result.status === "duplicate");
    assert.ok(claimed && duplicate);
    assert.equal(duplicate.attemptId, claimed.claim.attemptId);
    assert.equal(
      await store.complete(claimed.claim, { tip: payload.evaluatedAt }, hash(72), {
        version: "0x0",
      }),
      true,
    );
    const replay = await store.claim(payload);
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.attemptId, claimed.claim.attemptId);
    assert.equal(replay.intentHash, hash(72));

    simulationStore = new PostgresSimulationStore(database.url);
    const simulationAttempt = await simulationStore.load(claimed.claim.attemptId, hash(72));
    assert.ok(simulationAttempt);
    assert.equal(
      await simulationStore.approve(simulationAttempt, {
        cycles: "1000",
        fee: "1000000",
        reward: "5000000000",
        margin: "4999000000",
        intentHash: hash(72),
      }),
      true,
    );
    const afterApproval = await store.claim(payload);
    assert.equal(afterApproval.status, "duplicate");
    assert.equal(afterApproval.attemptId, claimed.claim.attemptId);

    const sql = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      const [attempt] = await sql`
        SELECT count(*)::integer AS value, min(state)::text AS state,
               min(simulation->>'cycles') AS cycles
        FROM transaction_attempts
        WHERE job_id = ${job.jobId} AND sequence = ${job.sequence}
      `;
      assert.deepEqual(attempt, { value: 1, state: "awaiting_signature", cycles: "1000" });
    } finally {
      await sql.end({ timeout: 2 });
    }
  } finally {
    if (simulationStore) await simulationStore.close();
    if (store) await store.close();
    await database.admin.unsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end({ timeout: 2 });
  }
});
