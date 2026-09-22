import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { DatabaseClient } from "../apps/api/src/database/client.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";
import { CanonicalCheckpointStore, CheckpointError } from "../apps/api/src/indexer/checkpoints.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for checkpoint verification");

const databaseName = `automata_checkpoint_${randomBytes(6).toString("hex")}`;
if (!/^automata_checkpoint_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error("Refusing to manage an unexpected database name");
}
const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const testUrl = new URL(adminConnectionString);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
let databaseClient;

function hash(byte) {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

function block(networkId, blockNumber, byte, parentByte) {
  return {
    networkId,
    blockNumber: BigInt(blockNumber),
    blockHash: hash(byte),
    parentHash: hash(parentByte),
    blockTimestamp: BigInt(blockNumber) * 1_000n,
  };
}

async function canonicalRows(sql, networkId) {
  return sql`
    SELECT block_number::text, block_hash
    FROM canonical_blocks
    WHERE network_id = ${networkId}
    ORDER BY block_number
  `;
}

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await migrateDatabase({ connectionString: testUrl.href });
  const sql = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  try {
    for (const [id, genesisByte] of [
      ["local", 1],
      ["other", 2],
    ]) {
      await sql`
        INSERT INTO networks (
          id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
        ) VALUES (${id}, ${hash(genesisByte)}, 'local', 1, ${"03".repeat(32)})
      `;
    }
  } finally {
    await sql.end({ timeout: 2 });
  }

  databaseClient = DatabaseClient.open(testUrl.href);
  let store = new CanonicalCheckpointStore(databaseClient.database, 3);
  assert.equal((await store.record(block("local", 10, 10, 9))).status, "initialized");
  assert.equal((await store.record(block("local", 11, 11, 10))).status, "advanced");
  assert.equal((await store.record(block("local", 11, 11, 10))).status, "unchanged");
  await store.record(block("local", 12, 12, 11));
  await store.record(block("local", 13, 13, 12));
  await store.record(block("local", 14, 14, 13));
  await databaseClient.close();

  databaseClient = DatabaseClient.open(testUrl.href);
  store = new CanonicalCheckpointStore(databaseClient.database, 3);
  assert.deepEqual(await store.load("local"), { blockNumber: 14n, blockHash: hash(14) });

  const single = await store.record(block("local", 14, 24, 13));
  assert.equal(single.status, "reorganized");
  assert.equal(single.rolledBackBlocks, 1);
  const multiple = await store.record(block("local", 13, 23, 12));
  assert.equal(multiple.status, "reorganized");
  assert.equal(multiple.rolledBackBlocks, 2);
  await store.record(block("local", 14, 24, 23));
  await store.record(block("local", 15, 25, 24));
  assert.deepEqual(await store.load("local"), { blockNumber: 15n, blockHash: hash(25) });

  await assert.rejects(
    store.record(block("local", 13, 33, 12)),
    (error) => error instanceof CheckpointError && error.code === "REORG_BEYOND_WINDOW",
  );
  assert.deepEqual(await store.load("local"), { blockNumber: 15n, blockHash: hash(25) });

  assert.equal((await store.record(block("other", 100, 100, 99))).status, "initialized");
  assert.deepEqual(await store.load("other"), { blockNumber: 100n, blockHash: hash(100) });

  const inspect = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  try {
    assert.deepEqual(
      (await canonicalRows(inspect, "local")).map((row) => ({
        blockNumber: row.block_number,
        blockHash: row.block_hash,
      })),
      [
        { blockNumber: "13", blockHash: hash(23) },
        { blockNumber: "14", blockHash: hash(24) },
        { blockNumber: "15", blockHash: hash(25) },
      ],
    );
    assert.equal((await canonicalRows(inspect, "other")).length, 1);
  } finally {
    await inspect.end({ timeout: 2 });
  }
  await databaseClient.close();

  console.log(
    "Canonical checkpoints verified: restart, bounded retention, rollback, refusal, and network isolation",
  );
} finally {
  await databaseClient?.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
