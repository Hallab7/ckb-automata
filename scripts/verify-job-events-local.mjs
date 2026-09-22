import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createApiApplication } from "../apps/api/src/bootstrap.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for event verification");

const databaseName = `automata_job_events_${randomBytes(6).toString("hex")}`;
if (!/^automata_job_events_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error("Refusing to manage an unexpected database name");
}
const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const testUrl = new URL(adminConnectionString);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
let app;
let inspect;

const fixture = JSON.parse(
  await readFile(
    new URL("../contracts/fixtures/recurring_creation_v1.json", import.meta.url),
    "utf8",
  ),
);
const jobId = fixture.expected.job_id;
const hash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const attemptId = "018f3f10-7b6a-7cc2-8c7e-1ab2c3d4e5f6";
const firstEventId = 9_007_199_254_740_993n;

function environment() {
  return {
    AUTOMATA_PROFILE: "local",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: "0x5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3",
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: testUrl.href,
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
  };
}

const quietLogger = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await migrateDatabase({ connectionString: testUrl.href });
  inspect = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  await inspect`
    INSERT INTO networks (
      id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
    ) VALUES ('ckb_dev', ${environment().CKB_GENESIS_HASH}, 'local', 2, ${"2".repeat(64)})
  `;
  await inspect`
    INSERT INTO indexer_checkpoints (network_id, block_number, block_hash)
    VALUES ('ckb_dev', 20, ${hash(20)})
  `;
  await inspect`
    INSERT INTO jobs (
      network_id, job_id, outpoint_tx_hash, outpoint_index, sequence, owner_lock_hash,
      policy_script_hash, policy_kind, state, capacity, data, block_number, block_hash,
      transaction_index
    ) VALUES (
      'ckb_dev', ${jobId}, ${hash(11)}, 0, 0, ${fixture.owner_lock_hash},
      ${fixture.expected.policy_script_hash}, 'recurring', 'live', 30000000000,
      ${Buffer.from(fixture.expected.job_data.slice(2), "hex")}, 11, ${hash(11)}, 0
    )
  `;
  await inspect`
    INSERT INTO transaction_attempts (
      id, network_id, job_id, operation, state, tx_hash, submitted_at
    ) VALUES (
      ${attemptId}, 'ckb_dev', ${jobId}, 'execute', 'submitted', ${hash(50)},
      '2026-01-01T10:01:00.000Z'
    )
  `;

  const insertEvent = async ({
    id,
    type,
    source,
    blockNumber = null,
    blockHash = null,
    txHash = null,
    payload,
    occurredAt,
    canonical = true,
    orphanedAt = null,
  }) => {
    await inspect`
      INSERT INTO job_events (
        id, network_id, job_id, event_type, source, block_number, block_hash, tx_hash,
        payload, occurred_at, canonical, orphaned_at
      ) OVERRIDING SYSTEM VALUE VALUES (
        ${id}, 'ckb_dev', ${jobId}, ${type}, ${source}, ${blockNumber}, ${blockHash},
        ${txHash}, ${inspect.json(payload)}, ${occurredAt}, ${canonical}, ${orphanedAt}
      )
    `;
  };

  await insertEvent({
    id: firstEventId,
    type: "job_discovered",
    source: "indexed",
    blockNumber: "10",
    blockHash: hash(10),
    txHash: hash(10),
    payload: { transactionIndex: "0" },
    occurredAt: "2026-01-01T10:00:00.000Z",
    canonical: false,
    orphanedAt: "2026-01-01T10:03:00.000Z",
  });
  await insertEvent({
    id: firstEventId + 1n,
    type: "execution_queued",
    source: "operational",
    payload: { attemptId, retry: "0" },
    occurredAt: "2026-01-01T10:01:00.000Z",
  });
  await insertEvent({
    id: firstEventId + 2n,
    type: "execution_retry",
    source: "operational",
    payload: { attemptId, retry: "1" },
    occurredAt: "2026-01-01T10:02:00.000Z",
  });
  await insertEvent({
    id: firstEventId + 3n,
    type: "job_discovered",
    source: "indexed",
    blockNumber: "11",
    blockHash: hash(11),
    txHash: hash(11),
    payload: { transactionIndex: "0" },
    occurredAt: "2026-01-01T09:59:00.000Z",
  });
  await insertEvent({
    id: firstEventId + 4n,
    type: "job_recurring",
    source: "indexed",
    blockNumber: "20",
    blockHash: hash(20),
    txHash: hash(50),
    payload: { transactionIndex: "3" },
    occurredAt: "2026-01-01T10:04:00.000Z",
  });
  await insertEvent({
    id: firstEventId + 5n,
    type: "job_cancelled",
    source: "indexed",
    blockNumber: "19",
    blockHash: hash(19),
    txHash: hash(49),
    payload: { transactionIndex: "1" },
    occurredAt: "2026-01-01T10:03:00.000Z",
    canonical: false,
    orphanedAt: "2026-01-01T10:03:30.000Z",
  });
  await insertEvent({
    id: firstEventId + 6n,
    type: "job_cancelled",
    source: "indexed",
    blockNumber: "21",
    blockHash: hash(21),
    txHash: hash(51),
    payload: { transactionIndex: "0" },
    occurredAt: "2026-01-01T10:05:00.000Z",
  });
  await insertEvent({
    id: firstEventId + 7n,
    type: "job_recurring",
    source: "indexed",
    blockNumber: "21",
    blockHash: hash(21),
    txHash: hash(52),
    payload: { transactionIndex: "0" },
    occurredAt: "2026-01-01T10:05:00.000Z",
  });

  const result = await createApiApplication(environment(), { logger: quietLogger });
  app = result.app;
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  const get = async (url) => {
    const response = await fastify.inject({ method: "GET", url });
    return { status: response.statusCode, body: response.json() };
  };

  const first = await get(`/v1/jobs/${jobId}/events?limit=3`);
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.items.map(({ eventType }) => eventType),
    ["job_discovered", "execution_queued", "execution_retry"],
  );
  assert.equal(first.body.items[0].eventId, firstEventId.toString());
  assert.equal(first.body.items[0].confidence, "reorged");
  assert.equal(first.body.items[0].replacement.eventId, (firstEventId + 3n).toString());
  assert.equal(first.body.items[1].confidence, "observed");
  assert.equal(first.body.items[1].attempt.id, attemptId);
  assert.equal(first.body.items[2].attempt.id, attemptId);
  assert.ok(first.body.page.nextCursor);

  const second = await get(`/v1/jobs/${jobId}/events?limit=3&cursor=${first.body.page.nextCursor}`);
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.body.items.map(({ eventType }) => eventType),
    ["job_discovered", "job_recurring", "job_cancelled"],
  );
  assert.equal(second.body.items[0].confidence, "confirmed");
  assert.equal(second.body.items[1].confidence, "committed");
  assert.equal(second.body.items[1].attempt.id, attemptId);
  assert.equal(second.body.items[1].block.transactionIndex, "3");
  assert.equal(second.body.items[2].confidence, "reorged");
  assert.equal(second.body.items[2].replacement, null);
  assert.equal(second.body.page.nextCursor, null);

  const operational = await get(`/v1/jobs/${jobId}/events?source=operational`);
  assert.deepEqual(
    operational.body.items.map(({ eventType }) => eventType),
    ["execution_queued", "execution_retry"],
  );
  assert.equal((await get(`/v1/jobs/${hash(99)}/events`)).status, 404);

  await inspect`
    UPDATE indexer_checkpoints
    SET block_number = 21, block_hash = ${hash(21)}
    WHERE network_id = 'ckb_dev'
  `;
  const stale = await get(`/v1/jobs/${jobId}/events?limit=3&cursor=${first.body.page.nextCursor}`);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STALE_EVENT_CURSOR");

  console.log(
    "Job events verified: ordering, retries, confidence, bigint IDs, reorg links, and cursors",
  );
} finally {
  await app?.close();
  await inspect?.end({ timeout: 2 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
