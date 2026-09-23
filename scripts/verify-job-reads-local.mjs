import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createApiApplication } from "../apps/api/src/bootstrap.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";
import { JobDataV1 } from "../packages/molecule/src/index.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for job read verification");

const databaseName = `automata_job_reads_${randomBytes(6).toString("hex")}`;
if (!/^automata_job_reads_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error("Refusing to manage an unexpected database name");
}
const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const testUrl = new URL(adminConnectionString);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
let app;
let inspect;

const recurringFixture = JSON.parse(
  await readFile(
    new URL("../contracts/fixtures/recurring_creation_v1.json", import.meta.url),
    "utf8",
  ),
);
const deadlineFixture = JSON.parse(
  await readFile(
    new URL("../contracts/fixtures/deadline_creation_v1.json", import.meta.url),
    "utf8",
  ),
);
const recurringBase = JobDataV1.unpack(
  Buffer.from(recurringFixture.expected.job_data.slice(2), "hex"),
);
const maxUint64 = "18446744073709551615";
const blockHash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const txHash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

function recurringData(id, sequence = 0n, maximums = false) {
  return Buffer.from(
    JobDataV1.pack({
      ...recurringBase,
      job_id: Array(32).fill(id),
      sequence,
      ...(maximums ? { reward: BigInt(maxUint64), remaining_budget: BigInt(maxUint64) } : {}),
    }),
  );
}

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
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
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
    ) VALUES (
      'ckb_dev', ${environment().CKB_GENESIS_HASH}, 'local', 1, ${"1".repeat(64)}
    )
  `;
  await inspect`
    INSERT INTO indexer_checkpoints (network_id, block_number, block_hash)
    VALUES ('ckb_dev', 120, ${blockHash(120)})
  `;

  const rows = [
    {
      id: blockHash(1),
      tx: txHash(21),
      output: "0",
      sequence: "0",
      owner: recurringFixture.owner_lock_hash,
      policy: recurringFixture.expected.policy_script_hash,
      template: "recurring",
      state: "live",
      capacity: maxUint64,
      data: recurringData(1, 0n, true),
      block: "100",
      blockHash: blockHash(100),
      transaction: "2",
    },
    {
      id: blockHash(2),
      tx: txHash(22),
      output: "1",
      sequence: "0",
      owner: recurringFixture.owner_lock_hash,
      policy: recurringFixture.expected.policy_script_hash,
      template: "recurring",
      state: "spent",
      capacity: "30000000000",
      data: recurringData(2),
      block: "100",
      blockHash: blockHash(100),
      transaction: "2",
    },
    {
      id: blockHash(3),
      tx: txHash(23),
      output: "0",
      sequence: "0",
      owner: recurringFixture.owner_lock_hash,
      policy: recurringFixture.expected.policy_script_hash,
      template: "recurring",
      state: "orphaned",
      capacity: "30000000000",
      data: recurringData(3),
      block: "100",
      blockHash: blockHash(99),
      transaction: "1",
    },
    {
      id: deadlineFixture.expected.job_id,
      tx: txHash(24),
      output: "0",
      sequence: "0",
      owner: deadlineFixture.cancel_lock_hash,
      policy: deadlineFixture.expected.policy_script_hash,
      template: "deadline",
      state: "live",
      capacity: "20000000000",
      data: Buffer.from(deadlineFixture.expected.job_data.slice(2), "hex"),
      block: "99",
      blockHash: blockHash(98),
      transaction: "4",
    },
    {
      id: blockHash(5),
      tx: txHash(25),
      output: "0",
      sequence: "0",
      owner: recurringFixture.owner_lock_hash,
      policy: recurringFixture.expected.policy_script_hash,
      template: "recurring",
      state: "live",
      capacity: "30000000000",
      data: recurringData(5),
      block: "121",
      blockHash: blockHash(121),
      transaction: "0",
    },
  ];

  for (const row of rows) {
    await inspect`
      INSERT INTO jobs (
        network_id, job_id, outpoint_tx_hash, outpoint_index, sequence, owner_lock_hash,
        policy_script_hash, policy_kind, state, capacity, data, block_number, block_hash,
        transaction_index
      ) VALUES (
        'ckb_dev', ${row.id}, ${row.tx}, ${row.output}, ${row.sequence}, ${row.owner},
        ${row.policy}, ${row.template}, ${row.state}, ${row.capacity}, ${row.data}, ${row.block},
        ${row.blockHash}, ${row.transaction}
      )
    `;
  }

  const result = await createApiApplication(environment(), { logger: quietLogger });
  app = result.app;
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  const get = async (url) => {
    const response = await fastify.inject({ method: "GET", url });
    return { status: response.statusCode, body: response.json() };
  };

  const templates = await get("/v1/templates");
  assert.equal(templates.status, 200);
  assert.deepEqual(
    templates.body.items.map(({ id }) => id),
    ["deadline", "recurring"],
  );

  const first = await get("/v1/jobs?limit=2");
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.items.map(({ jobId }) => jobId),
    [blockHash(2), blockHash(1)],
  );
  assert.equal(typeof first.body.items[1].funds.capacity, "string");
  assert.equal(first.body.items[1].funds.capacity, maxUint64);
  assert.equal(first.body.items[1].funds.executorReward, maxUint64);
  assert.equal(first.body.items[1].funds.remainingBudget, maxUint64);
  assert.equal(first.body.items[1].source.block.number, "100");
  assert.equal(first.body.indexCheckpoint.blockNumber, "120");
  assert.ok(first.body.page.nextCursor);

  const second = await get(`/v1/jobs?limit=2&cursor=${first.body.page.nextCursor}`);
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.body.items.map(({ jobId }) => jobId),
    [blockHash(3), deadlineFixture.expected.job_id],
  );
  assert.equal(second.body.items[0].source.canonical, false);
  assert.equal(second.body.page.nextCursor, null);

  const deadline = await get("/v1/jobs?template=deadline");
  assert.deepEqual(
    deadline.body.items.map(({ template }) => template),
    ["deadline"],
  );
  const live = await get("/v1/jobs?state=live");
  assert.deepEqual(
    live.body.items.map(({ jobId }) => jobId),
    [blockHash(1), deadlineFixture.expected.job_id],
  );
  const owner = await get(`/v1/accounts/${recurringFixture.owner_lock_hash}/jobs`);
  assert.equal(owner.body.items.length, 3);

  const detail = await get(`/v1/jobs/${blockHash(1)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.jobId, blockHash(1));
  assert.equal(detail.body.protocol.rawData, `0x${recurringData(1, 0n, true).toString("hex")}`);
  assert.equal((await get(`/v1/jobs/${blockHash(5)}`)).status, 404);
  assert.equal((await get(`/v1/jobs/${blockHash(88)}`)).status, 404);
  assert.equal((await get("/v1/jobs?state=invalid")).status, 400);

  const mismatched = await get(`/v1/jobs?limit=2&state=live&cursor=${first.body.page.nextCursor}`);
  assert.equal(mismatched.status, 400);
  assert.equal(mismatched.body.code, "INVALID_JOB_QUERY");

  const oversizedPayload = JSON.parse(
    Buffer.from(first.body.page.nextCursor, "base64url").toString("utf8"),
  );
  oversizedPayload.b = "18446744073709551616";
  const oversizedCursor = Buffer.from(JSON.stringify(oversizedPayload), "utf8").toString(
    "base64url",
  );
  const oversized = await get(`/v1/jobs?limit=2&cursor=${oversizedCursor}`);
  assert.equal(oversized.status, 400);
  assert.equal(oversized.body.code, "INVALID_JOB_QUERY");

  await inspect`
    UPDATE indexer_checkpoints
    SET block_number = 121, block_hash = ${blockHash(121)}
    WHERE network_id = 'ckb_dev'
  `;
  const stale = await get(`/v1/jobs?limit=2&cursor=${first.body.page.nextCursor}`);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STALE_JOB_CURSOR");

  console.log(
    "Job reads verified: routes, filters, stable cursors, provenance, and uint64 serialization",
  );
} finally {
  await app?.close();
  await inspect?.end({ timeout: 2 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
