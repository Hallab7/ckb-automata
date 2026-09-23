import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { migrateDatabase } from "../../api/src/database/migrator.ts";
import { PostgresConfirmationStore } from "../src/confirmation-store.ts";
import { ConfirmationService } from "../src/confirmation.ts";

const databaseUrl = process.env["AUTOMATA_INTEGRATION_DATABASE_URL"];
if (!databaseUrl) throw new Error("AUTOMATA_INTEGRATION_DATABASE_URL is required");

const network = "ckb_dev";
const now = new Date("2026-09-23T12:00:00.000Z");

function hash(byte) {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

async function createDatabase() {
  const name = `automata_contention_${randomBytes(6).toString("hex")}`;
  if (!/^automata_contention_[0-9a-f]{12}$/.test(name)) {
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

async function seedContention(url) {
  const attemptId = randomUUID();
  const jobId = hash(17);
  const jobOutPoint = { txHash: hash(18), index: "0" };
  const losingTransactionHash = hash(19);
  const winningTransactionHash = hash(20);
  const winningExecutorLockHash = hash(21);
  const successorOutPoint = { txHash: winningTransactionHash, index: "2" };
  const blockHash = hash(22);
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql`
      INSERT INTO networks (
        id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
      ) VALUES (${network}, ${hash(1)}, 'local', 2, ${"a".repeat(64)})
    `;
    await sql`
      INSERT INTO jobs (
        network_id, job_id, outpoint_tx_hash, outpoint_index, sequence,
        owner_lock_hash, policy_script_hash, policy_kind, state, capacity,
        data, block_number, block_hash, transaction_index
      ) VALUES (
        ${network}, ${jobId}, ${jobOutPoint.txHash}, ${jobOutPoint.index}, '0',
        ${hash(2)}, ${hash(3)}, 'recurring', 'live', '10000000000',
        ${Buffer.from([1])}, '90', ${hash(4)}, '0'
      )
    `;
    await sql`
      INSERT INTO transaction_attempts (
        id, network_id, job_id, sequence, operation, state, chain_snapshot,
        intent_hash, unsigned_tx_hash, unsigned_transaction, tx_hash, submitted_at
      ) VALUES (
        ${attemptId}, ${network}, ${jobId}, '0', 'execute', 'submitted',
        ${sql.json({ job: { outPoint: jobOutPoint } })},
        ${losingTransactionHash}, ${losingTransactionHash}, ${sql.json({ version: "0x0" })},
        ${losingTransactionHash}, ${now}
      )
    `;
    await sql`
      INSERT INTO indexer_checkpoints (network_id, block_number, block_hash)
      VALUES (${network}, '100', ${blockHash})
    `;
    await sql`
      INSERT INTO job_events (
        network_id, job_id, event_type, source, block_number, block_hash,
        tx_hash, payload, occurred_at
      ) VALUES (
        ${network}, ${jobId}, 'job_recurring', 'indexed', '100', ${blockHash},
        ${winningTransactionHash},
        ${sql.json({
          previousOutpoint: jobOutPoint,
          successorOutpoint: successorOutPoint,
          executorLockHash: winningExecutorLockHash,
        })},
        ${now}
      )
    `;
  } finally {
    await sql.end({ timeout: 2 });
  }
  return {
    attemptId,
    losingTransactionHash,
    winningTransactionHash,
    winningExecutorLockHash,
    successorOutPoint,
  };
}

test("two executor instances record one accurate losing contention result", async () => {
  const database = await createDatabase();
  const stores = [];
  try {
    const contention = await seedContention(database.url);
    const chain = {
      async getTransactionStatus() {
        return {
          status: "pending",
          transaction: { hash: () => contention.losingTransactionHash },
        };
      },
    };
    const services = Array.from({ length: 2 }, () => {
      const store = new PostgresConfirmationStore(database.url, network, () => now);
      stores.push(store);
      return new ConfirmationService({ store, chain });
    });
    const results = await Promise.all(
      services.map((service) =>
        service.track({
          attemptId: contention.attemptId,
          transactionHash: contention.losingTransactionHash,
        }),
      ),
    );
    assert.deepEqual(results.map((result) => result.status).toSorted(), ["stale", "transitioned"]);

    const sql = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      const [attempt] = await sql`
        SELECT state, error_code, error_detail
        FROM transaction_attempts
        WHERE id = ${contention.attemptId}
      `;
      assert.deepEqual(attempt, {
        state: "conflicted",
        error_code: "EXECUTOR_ALREADY_CONSUMED",
        error_detail: {
          winningTransactionHash: contention.winningTransactionHash,
          winningExecutorLockHash: contention.winningExecutorLockHash,
          successorOutPoint: contention.successorOutPoint,
        },
      });
      const events = await sql`
        SELECT tx_hash, payload
        FROM job_events
        WHERE event_type = 'transaction_conflicted'
      `;
      assert.equal(events.length, 1);
      assert.equal(events[0].tx_hash, contention.winningTransactionHash);
      assert.deepEqual(events[0].payload, {
        attemptId: contention.attemptId,
        observedStatus: "pending",
        errorCode: "EXECUTOR_ALREADY_CONSUMED",
        relatedTransactionHash: contention.winningTransactionHash,
        winningExecutorLockHash: contention.winningExecutorLockHash,
        successorOutPoint: contention.successorOutPoint,
      });
    } finally {
      await sql.end({ timeout: 2 });
    }
  } finally {
    await Promise.all(stores.map((store) => store.close()));
    await database.admin.unsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end({ timeout: 2 });
  }
});
