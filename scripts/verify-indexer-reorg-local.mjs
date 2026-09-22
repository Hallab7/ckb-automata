import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { deploymentRegistry } from "../packages/core/src/index.ts";
import { JobDataV1 } from "../packages/molecule/src/index.ts";
import { DatabaseClient } from "../apps/api/src/database/client.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";
import { CanonicalCheckpointStore } from "../apps/api/src/indexer/checkpoints.ts";
import { JobCellDiscovery } from "../apps/api/src/indexer/job-discovery.ts";
import { JobTransitionIndexer } from "../apps/api/src/indexer/job-transitions.ts";
import { CanonicalBlockProjector, JobProjectionRollback } from "../apps/api/src/indexer/reorg.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const shellModule = await import(pathToFileURL(requireFromApi.resolve("@ckb-ccc/shell")).href);
const { WitnessArgs } = shellModule.default ?? shellModule;
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for reorg verification");

const databaseName = `automata_reorg_${randomBytes(6).toString("hex")}`;
if (!/^automata_reorg_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error("Refusing to manage an unexpected database name");
}
const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const testUrl = new URL(adminConnectionString);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
let databaseClient;

const manifest = JSON.parse(
  await readFile(new URL("../deploy/manifests/local.json", import.meta.url), "utf8"),
);
const fixture = JSON.parse(
  await readFile(
    new URL("../contracts/fixtures/recurring_creation_v1.json", import.meta.url),
    "utf8",
  ),
);
const loaded = await deploymentRegistry.load(manifest.genesisHash);
if (loaded.status !== "ok") throw new Error("local deployment fixture is unavailable");
const deployment = loaded.deployment;
const base = JobDataV1.unpack(Buffer.from(fixture.expected.job_data.slice(2), "hex"));
const hash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const jobId = hash(7);

function jobData(overrides = {}) {
  return `0x${Buffer.from(
    JobDataV1.pack({ ...base, job_id: Array(32).fill(7), ...overrides }),
  ).toString("hex")}`;
}

function jobOutput() {
  return {
    capacity: 30_000_000_000n,
    lock: { ...deployment.contracts["job-lock"].script, args: "0x" },
    type: { ...deployment.contracts["recurring-policy"].script, args: "0x" },
  };
}

function block(number, blockHash, parentHash, transactions = []) {
  return {
    header: {
      number: BigInt(number),
      hash: blockHash,
      parentHash,
      timestamp: 1_800_000_000_000n + BigInt(number) * 1_000n,
    },
    transactions,
  };
}

function creation(txHash, data) {
  return {
    hash: () => txHash,
    inputs: [],
    outputs: [jobOutput()],
    outputsData: [data],
    witnesses: [],
  };
}

function execution(txHash, previousTxHash, data) {
  const inputType = `0x00${"00000000"}${"11".repeat(32)}01${"00000000"}`;
  return {
    hash: () => txHash,
    inputs: [{ previousOutput: { txHash: previousTxHash, index: 0n } }],
    outputs: data ? [jobOutput()] : [],
    outputsData: data ? [data] : [],
    witnesses: [WitnessArgs.from({ inputType }).toHex()],
  };
}

const block10 = block(10, hash(10), hash(9));
const orphanCreationTx = hash(21);
const block11a = block(11, hash(11), hash(10), [creation(orphanCreationTx, jobData())]);
const block11b = block(11, hash(111), hash(10));
const canonicalCreationTx = hash(22);
const block12 = block(12, hash(12), hash(111), [creation(canonicalCreationTx, jobData())]);
const orphanExecutionTx = hash(23);
const successorData = jobData({
  sequence: 1n,
  remaining_runs: 2,
  remaining_budget: BigInt(base.remaining_budget) - BigInt(base.reward),
});
const block13a = block(13, hash(13), hash(12), [
  execution(orphanExecutionTx, canonicalCreationTx, successorData),
]);
const canonicalExecutionTx = hash(24);
const block13b = block(13, hash(113), hash(12), [
  execution(canonicalExecutionTx, canonicalCreationTx),
]);

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await migrateDatabase({ connectionString: testUrl.href });
  const seed = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  try {
    await seed`
      INSERT INTO networks (
        id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
      ) VALUES (
        ${deployment.network}, ${deployment.genesisHash}, 'local',
        ${deployment.confirmation.requiredDepth}, ${deployment.manifestSha256}
      )
    `;
  } finally {
    await seed.end({ timeout: 2 });
  }

  databaseClient = DatabaseClient.open(testUrl.href);
  const unusedClient = { getBlockByNumber: async () => undefined };
  const checkpoints = new CanonicalCheckpointStore(databaseClient.database, 8);
  const discovery = new JobCellDiscovery(databaseClient.database, unusedClient);
  const transitions = new JobTransitionIndexer(databaseClient.database, unusedClient);
  const rollback = new JobProjectionRollback(databaseClient.database);
  const projector = new CanonicalBlockProjector(
    unusedClient,
    checkpoints,
    rollback,
    discovery,
    transitions,
  );

  await projector.projectBlock(block10, deployment);
  await projector.projectBlock(block11a, deployment);
  const beforeExecution = await projector.projectBlock(block11b, deployment);
  assert.deepEqual(beforeExecution.rollback, {
    rolledBackBlocks: 1,
    orphanedEvents: 1,
    orphanedVersions: 1,
    restoredJobs: 0,
    orphanedJobs: 1,
    checkpoint: { blockNumber: 10n, blockHash: hash(10) },
  });

  await projector.projectBlock(block12, deployment);
  await projector.projectBlock(block13a, deployment);
  const afterExecution = await projector.projectBlock(block13b, deployment);
  assert.deepEqual(afterExecution.rollback, {
    rolledBackBlocks: 1,
    orphanedEvents: 1,
    orphanedVersions: 1,
    restoredJobs: 1,
    orphanedJobs: 0,
    checkpoint: { blockNumber: 12n, blockHash: hash(12) },
  });

  const inspect = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  try {
    const [current] = await inspect`
      SELECT state, sequence::text, outpoint_tx_hash, block_hash
      FROM jobs
      WHERE network_id = ${deployment.network} AND job_id = ${jobId}
    `;
    assert.deepEqual(current, {
      state: "spent",
      sequence: "0",
      outpoint_tx_hash: canonicalCreationTx,
      block_hash: hash(113),
    });

    const events = (
      await inspect`
        SELECT tx_hash, canonical, orphaned_at IS NOT NULL AS orphaned
        FROM job_events
        ORDER BY id
      `
    ).map(({ tx_hash, canonical, orphaned }) => ({ tx_hash, canonical, orphaned }));
    assert.deepEqual(events, [
      { tx_hash: orphanCreationTx, canonical: false, orphaned: true },
      { tx_hash: canonicalCreationTx, canonical: true, orphaned: false },
      { tx_hash: orphanExecutionTx, canonical: false, orphaned: true },
      { tx_hash: canonicalExecutionTx, canonical: true, orphaned: false },
    ]);
    assert.deepEqual(
      events.filter(({ canonical }) => canonical).map(({ tx_hash }) => tx_hash),
      [canonicalCreationTx, canonicalExecutionTx],
    );

    const versions = (
      await inspect`
        SELECT outpoint_tx_hash, status, spent_tx_hash, transaction_index::text
        FROM job_versions
        ORDER BY id
      `
    ).map(({ outpoint_tx_hash, status, spent_tx_hash, transaction_index }) => ({
      outpoint_tx_hash,
      status,
      spent_tx_hash,
      transaction_index,
    }));
    assert.deepEqual(versions, [
      {
        outpoint_tx_hash: orphanCreationTx,
        status: "orphaned",
        spent_tx_hash: null,
        transaction_index: "0",
      },
      {
        outpoint_tx_hash: canonicalCreationTx,
        status: "spent",
        spent_tx_hash: canonicalExecutionTx,
        transaction_index: "0",
      },
      {
        outpoint_tx_hash: orphanExecutionTx,
        status: "orphaned",
        spent_tx_hash: null,
        transaction_index: "0",
      },
    ]);

    const canonical = (
      await inspect`
        SELECT block_number::text, block_hash
        FROM canonical_blocks
        WHERE network_id = ${deployment.network}
        ORDER BY block_number
      `
    ).map(({ block_number, block_hash }) => ({ block_number, block_hash }));
    assert.deepEqual(canonical, [
      { block_number: "10", block_hash: hash(10) },
      { block_number: "11", block_hash: hash(111) },
      { block_number: "12", block_hash: hash(12) },
      { block_number: "13", block_hash: hash(113) },
    ]);
    assert.deepEqual(await checkpoints.load(deployment.network), {
      blockNumber: 13n,
      blockHash: hash(113),
    });

    const replay = await projector.projectBlock(block13b, deployment);
    assert.equal(replay.checkpoint.status, "unchanged");
    const [{ count }] = await inspect`SELECT count(*)::integer AS count FROM job_events`;
    assert.equal(count, 4);
  } finally {
    await inspect.end({ timeout: 2 });
  }

  console.log("Indexer reorg verified: orphan evidence, projection rollback, and branch replay");
} finally {
  await databaseClient?.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
