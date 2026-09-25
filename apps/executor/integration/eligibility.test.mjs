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
import { DatabaseClient } from "../../api/src/database/client.ts";
import { PostgresLockResolutionRecorder } from "../../api/src/lock-resolutions.ts";
import { PostgresBuildAttemptStore } from "../src/build-store.ts";
import { PostgresConfirmationStore } from "../src/confirmation-store.ts";
import { ConfirmationService } from "../src/confirmation.ts";
import { ExecutorReceiptSigner } from "../src/receipt.ts";
import { operatorLockArgs } from "../src/signing.ts";
import { PostgresSimulationStore } from "../src/simulation-store.ts";
import { PostgresSubmissionStore } from "../src/submission-store.ts";
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

const receiptPrivateKey = `0x${"0b".repeat(32)}`;
const receipts = new ExecutorReceiptSigner({
  network: deployment.network,
  privateKey: receiptPrivateKey,
  executorLock: {
    codeHash: hash(5),
    hashType: "type",
    args: operatorLockArgs(receiptPrivateKey),
  },
  version: "0.0.0-test",
  revision: "1234567",
});

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
    async send() {
      throw new Error("submission is not configured by this test");
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
        enableConfirmationWorkers: false,
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
  let submissionStore;
  let confirmationStore;
  let databaseClient;
  try {
    const job = await seedJob(database.url);
    store = new PostgresBuildAttemptStore(database.url, deployment.network);
    databaseClient = DatabaseClient.open(database.url);
    const resolvedLock = {
      codeHash: hash(90),
      hashType: "type",
      args: "0xab",
    };
    await new PostgresLockResolutionRecorder(databaseClient.database, deployment.network).remember([
      resolvedLock,
      resolvedLock,
    ]);
    assert.deepEqual(await store.loadResolvedLocks(), [resolvedLock]);
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
    submissionStore = new PostgresSubmissionStore(
      database.url,
      () => new Date("2026-09-23T10:00:00.000Z"),
    );
    const submissionAttempt = await submissionStore.load(claimed.claim.attemptId, hash(72));
    assert.ok(submissionAttempt);
    assert.equal(submissionAttempt.state, "awaiting_signature");
    assert.equal(
      await submissionStore.markSubmitted(submissionAttempt, hash(72), "broadcast"),
      true,
    );
    assert.equal(
      await submissionStore.markSubmitted(submissionAttempt, hash(72), "broadcast"),
      false,
    );
    const evidenceSql = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      await evidenceSql`
        UPDATE networks SET confirmation_depth = 2 WHERE id = ${deployment.network}
      `;
      await evidenceSql`
        INSERT INTO canonical_blocks (
          network_id, block_number, block_hash, parent_hash, block_timestamp
        ) VALUES (${deployment.network}, '100', ${hash(100)}, ${hash(99)}, '1')
      `;
      await evidenceSql`
        INSERT INTO indexer_checkpoints (network_id, block_number, block_hash)
        VALUES (${deployment.network}, '100', ${hash(100)})
      `;
      await evidenceSql`
        INSERT INTO job_events (
          network_id, job_id, event_type, source, block_number, block_hash,
          tx_hash, payload, occurred_at
        ) VALUES (
          ${deployment.network}, ${job.jobId}, 'job_one_shot', 'indexed', '100', ${hash(100)},
          ${hash(72)},
          ${evidenceSql.json({ previousOutpoint: { txHash: hash(71), index: "0" } })},
          ${new Date("2026-09-23T10:00:00.000Z")}
        )
      `;
    } finally {
      await evidenceSql.end({ timeout: 2 });
    }

    confirmationStore = new PostgresConfirmationStore(
      database.url,
      deployment.network,
      () => new Date("2026-09-23T10:01:00.000Z"),
    );
    const confirmation = new ConfirmationService({
      store: confirmationStore,
      receipts,
      now: () => new Date("2026-09-23T10:01:00.000Z"),
      chain: {
        async getTransactionStatus() {
          return { status: "pending", transaction: { hash: () => hash(72) } };
        },
      },
    });
    assert.deepEqual(
      await confirmation.track({
        attemptId: claimed.claim.attemptId,
        transactionHash: hash(72),
      }),
      { status: "transitioned", state: "committed" },
    );
    const depthSql = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      await depthSql`
        INSERT INTO canonical_blocks (
          network_id, block_number, block_hash, parent_hash, block_timestamp
        ) VALUES (${deployment.network}, '101', ${hash(101)}, ${hash(100)}, '2')
      `;
      await depthSql`
        UPDATE indexer_checkpoints
        SET block_number = '101', block_hash = ${hash(101)}, updated_at = now()
        WHERE network_id = ${deployment.network}
      `;
    } finally {
      await depthSql.end({ timeout: 2 });
    }
    assert.deepEqual(
      await confirmation.track({
        attemptId: claimed.claim.attemptId,
        transactionHash: hash(72),
      }),
      { status: "transitioned", state: "confirmed" },
    );
    assert.deepEqual(await confirmationStore.listPending(), []);
    const afterApproval = await store.claim(payload);
    assert.equal(afterApproval.status, "duplicate");
    assert.equal(afterApproval.attemptId, claimed.claim.attemptId);

    const sql = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      const [attempt] = await sql`
        SELECT count(*)::integer AS value, min(attempt.state)::text AS state,
               min(attempt.simulation->>'cycles') AS cycles,
               count(event.id)::integer AS events,
               min(event.payload->>'acceptance') AS acceptance,
               (
                 SELECT count(*)::integer FROM job_events AS tracked
                 WHERE tracked.payload->>'attemptId' = attempt.id::text
               ) AS tracked_events,
               (
                 SELECT count(*)::integer FROM job_events AS confirmed
                 WHERE confirmed.payload->>'attemptId' = attempt.id::text
                   AND confirmed.event_type = 'transaction_confirmed'
               ) AS confirmed_events
        FROM transaction_attempts AS attempt
        LEFT JOIN job_events AS event
          ON event.payload->>'attemptId' = attempt.id::text
         AND event.event_type = 'transaction_submitted'
        WHERE attempt.job_id = ${job.jobId} AND attempt.sequence = ${job.sequence}
        GROUP BY attempt.id
      `;
      assert.deepEqual(attempt, {
        value: 1,
        state: "confirmed",
        cycles: "1000",
        events: 1,
        acceptance: "broadcast",
        tracked_events: 3,
        confirmed_events: 1,
      });
    } finally {
      await sql.end({ timeout: 2 });
    }
  } finally {
    if (databaseClient) await databaseClient.close();
    if (confirmationStore) await confirmationStore.close();
    if (submissionStore) await submissionStore.close();
    if (simulationStore) await simulationStore.close();
    if (store) await store.close();
    await database.admin.unsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end({ timeout: 2 });
  }
});
