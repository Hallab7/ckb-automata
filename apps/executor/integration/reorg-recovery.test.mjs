import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { migrateDatabase } from "../../api/src/database/migrator.ts";
import { PostgresConfirmationStore } from "../src/confirmation-store.ts";
import { ConfirmationService } from "../src/confirmation.ts";
import { ExecutorReceiptSigner, verifyExecutorReceipt } from "../src/receipt.ts";
import { operatorLockArgs } from "../src/signing.ts";

const databaseUrl = process.env["AUTOMATA_INTEGRATION_DATABASE_URL"];
if (!databaseUrl) throw new Error("AUTOMATA_INTEGRATION_DATABASE_URL is required");

const network = "ckb_dev";
const now = new Date("2026-09-23T13:00:00.000Z");

function hash(byte) {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

const receiptPrivateKey = `0x${"0c".repeat(32)}`;
const receipts = new ExecutorReceiptSigner({
  network,
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
  const name = `automata_reorg_${randomBytes(6).toString("hex")}`;
  if (!/^automata_reorg_[0-9a-f]{12}$/.test(name)) {
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

async function seedNetwork(url) {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql`
      INSERT INTO networks (
        id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
      ) VALUES (${network}, ${hash(1)}, 'local', 2, ${"a".repeat(64)})
    `;
    await sql`
      INSERT INTO indexer_checkpoints (network_id, block_number, block_hash)
      VALUES (${network}, '101', ${hash(101)})
    `;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function seedAttempt(url, byte, replacement) {
  const attemptId = randomUUID();
  const jobId = hash(byte);
  const originalOutPoint = { txHash: hash(byte + 1), index: "0" };
  const orphanedTransactionHash = hash(byte + 2);
  const successorOutPoint = { txHash: hash(byte + 3), index: "2" };
  const currentOutPoint = replacement ? successorOutPoint : originalOutPoint;
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql`
      INSERT INTO jobs (
        network_id, job_id, outpoint_tx_hash, outpoint_index, sequence,
        owner_lock_hash, policy_script_hash, policy_kind, state, capacity,
        data, block_number, block_hash, transaction_index
      ) VALUES (
        ${network}, ${jobId}, ${currentOutPoint.txHash}, ${currentOutPoint.index},
        ${replacement ? "1" : "0"}, ${hash(2)}, ${hash(3)}, 'recurring', 'live',
        '10000000000', ${Buffer.from([1])}, ${replacement ? "101" : "90"},
        ${replacement ? hash(101) : hash(90)}, '0'
      )
    `;
    await sql`
      INSERT INTO transaction_attempts (
        id, network_id, job_id, sequence, operation, state, chain_snapshot,
        intent_hash, unsigned_tx_hash, unsigned_transaction, tx_hash,
        submitted_at, committed_block_number
      ) VALUES (
        ${attemptId}, ${network}, ${jobId}, '0', 'execute', 'committed',
        ${sql.json({ job: { outPoint: originalOutPoint } })},
        ${orphanedTransactionHash}, ${orphanedTransactionHash},
        ${sql.json({ version: "0x0" })}, ${orphanedTransactionHash}, ${now}, '100'
      )
    `;
    await sql`
      INSERT INTO job_events (
        network_id, job_id, event_type, source, block_number, block_hash,
        tx_hash, payload, occurred_at, canonical, orphaned_at
      ) VALUES (
        ${network}, ${jobId}, 'job_recurring', 'indexed', '100', ${hash(100)},
        ${orphanedTransactionHash},
        ${sql.json({ previousOutpoint: originalOutPoint, successorOutpoint: successorOutPoint })},
        ${now}, false, ${now}
      )
    `;
    if (replacement) {
      await sql`
        INSERT INTO job_events (
          network_id, job_id, event_type, source, block_number, block_hash,
          tx_hash, payload, occurred_at
        ) VALUES (
          ${network}, ${jobId}, 'job_recurring', 'indexed', '101', ${hash(101)},
          ${successorOutPoint.txHash},
          ${sql.json({
            previousOutpoint: originalOutPoint,
            successorOutpoint: successorOutPoint,
            executorLockHash: hash(byte + 4),
          })},
          ${now}
        )
      `;
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
  return { attemptId, jobId, originalOutPoint, orphanedTransactionHash, successorOutPoint };
}

function service(store, attempt, requeued) {
  return new ConfirmationService({
    store,
    receipts,
    now: () => now,
    chain: {
      async getTransactionStatus() {
        return {
          status: "unknown",
          transaction: { hash: () => attempt.orphanedTransactionHash },
        };
      },
    },
    recovery: {
      async requeue(value) {
        requeued.push({
          attemptId: value.attemptId,
          jobId: value.jobId,
          sequence: value.sequence,
        });
      },
    },
  });
}

test("reorg recovery requeues only a restored canonical input", async () => {
  const database = await createDatabase();
  const stores = [];
  try {
    await seedNetwork(database.url);
    const restored = await seedAttempt(database.url, 30, false);
    const replaced = await seedAttempt(database.url, 40, true);
    const requeued = [];
    const restoredStore = new PostgresConfirmationStore(database.url, network, () => now);
    const replacedStore = new PostgresConfirmationStore(database.url, network, () => now);
    stores.push(restoredStore, replacedStore);

    assert.deepEqual(
      await service(restoredStore, restored, requeued).track({
        attemptId: restored.attemptId,
        transactionHash: restored.orphanedTransactionHash,
      }),
      { status: "transitioned", state: "reorged" },
    );
    assert.deepEqual(requeued, [
      { attemptId: restored.attemptId, jobId: restored.jobId, sequence: "0" },
    ]);
    assert.deepEqual(
      await service(restoredStore, restored, requeued).track({
        attemptId: restored.attemptId,
        transactionHash: restored.orphanedTransactionHash,
      }),
      { status: "requeued" },
    );
    assert.equal(requeued.length, 2);

    assert.deepEqual(
      await service(replacedStore, replaced, requeued).track({
        attemptId: replaced.attemptId,
        transactionHash: replaced.orphanedTransactionHash,
      }),
      { status: "transitioned", state: "conflicted" },
    );
    assert.equal(requeued.length, 2);

    const sql = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      const attempts = await sql`
        SELECT id::text, state, error_code, error_detail
        FROM transaction_attempts
        ORDER BY id
      `;
      const restoredRow = attempts.find((row) => row.id === restored.attemptId);
      assert.equal(restoredRow.state, "reorged");
      assert.equal(restoredRow.error_code, "EXECUTOR_TX_REORGED");
      assert.equal(
        restoredRow.error_detail.originalOutPoint.txHash,
        restored.originalOutPoint.txHash,
      );
      const replacedRow = attempts.find((row) => row.id === replaced.attemptId);
      assert.equal(replacedRow.state, "conflicted");
      assert.equal(
        replacedRow.error_detail.winningTransactionHash,
        replaced.successorOutPoint.txHash,
      );
      const [events] = await sql`
        SELECT count(*)::integer AS value
        FROM job_events
        WHERE event_type = 'transaction_reorged'
      `;
      assert.equal(events.value, 1);
      const signed = await sql`
        SELECT id::text, attempt_id::text, executor_lock_hash, payload, signature, key_id,
               created_at
        FROM executor_receipts
      `;
      assert.equal(signed.length, 1);
      assert.equal(signed[0].attempt_id, replaced.attemptId);
      assert.equal(signed[0].payload.authority, "non_authoritative");
      assert.equal(
        verifyExecutorReceipt({
          receiptId: signed[0].id,
          attemptId: signed[0].attempt_id,
          executorLockHash: signed[0].executor_lock_hash,
          payload: signed[0].payload,
          signature: signed[0].signature,
          keyId: signed[0].key_id,
          createdAt: signed[0].created_at,
        }),
        true,
      );
    } finally {
      await sql.end({ timeout: 2 });
    }
  } finally {
    await Promise.all(stores.map((store) => store.close()));
    await database.admin.unsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
    await database.admin.end({ timeout: 2 });
  }
});
