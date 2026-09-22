import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { deploymentRegistry } from "../packages/core/src/index.ts";
import { DatabaseClient } from "../apps/api/src/database/client.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";
import { JobCellDiscovery } from "../apps/api/src/indexer/job-discovery.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for discovery verification");

const databaseName = `automata_discovery_${randomBytes(6).toString("hex")}`;
if (!/^automata_discovery_[0-9a-f]{12}$/.test(databaseName)) {
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
const txHash = `0x${"33".repeat(32)}`;
const blockHash = `0x${"42".repeat(32)}`;
const block = {
  header: { number: 42n, hash: blockHash, timestamp: 1_800_000_000_000n },
  transactions: [
    {
      hash: () => txHash,
      outputs: [
        {
          capacity: 20_000_000_000n,
          lock: { ...deployment.contracts["job-lock"].script, args: "0x" },
          type: { ...deployment.contracts["recurring-policy"].script, args: "0x" },
        },
      ],
      outputsData: [fixture.expected.job_data],
    },
  ],
};

async function counts(sql) {
  const [row] = await sql`
    SELECT
      (SELECT count(*)::integer FROM jobs) AS jobs,
      (SELECT count(*)::integer FROM job_versions) AS versions,
      (SELECT count(*)::integer FROM job_events) AS events
  `;
  return row;
}

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await migrateDatabase({ connectionString: testUrl.href });
  const sql = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  try {
    await sql`
      INSERT INTO networks (
        id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
      ) VALUES (
        ${deployment.network}, ${deployment.genesisHash}, 'local',
        ${deployment.confirmation.requiredDepth}, ${deployment.manifestSha256}
      )
    `;
  } finally {
    await sql.end({ timeout: 2 });
  }

  databaseClient = DatabaseClient.open(testUrl.href);
  const discovery = new JobCellDiscovery(databaseClient.database, {
    getBlockByNumber: async (blockNumber) => (BigInt(blockNumber) === 42n ? block : undefined),
  });
  const first = await discovery.scanBlock(42n, deployment);
  assert.equal(first.insertedJobs, 1);
  assert.equal(first.existingJobs, 0);
  const duplicate = await discovery.projectBlock(block, deployment);
  assert.equal(duplicate.insertedJobs, 0);
  assert.equal(duplicate.existingJobs, 1);

  const inspect = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  try {
    assert.deepEqual(await counts(inspect), { jobs: 1, versions: 1, events: 1 });
    const [job] = await inspect`
      SELECT
        job_id, outpoint_tx_hash, outpoint_index::text, policy_kind,
        block_number::text, block_hash, transaction_index::text
      FROM jobs
    `;
    assert.deepEqual(job, {
      job_id: fixture.expected.job_id,
      outpoint_tx_hash: txHash,
      outpoint_index: "0",
      policy_kind: "recurring",
      block_number: "42",
      block_hash: blockHash,
      transaction_index: "0",
    });

    await inspect`DELETE FROM jobs WHERE network_id = ${deployment.network}`;
    assert.deepEqual(await counts(inspect), { jobs: 0, versions: 0, events: 0 });
    const rebuilt = await Promise.all([
      discovery.scanBlock(42n, deployment),
      discovery.scanBlock(42n, deployment),
    ]);
    assert.equal(
      rebuilt.reduce((total, result) => total + result.insertedJobs, 0),
      1,
    );
    assert.equal(
      rebuilt.reduce((total, result) => total + result.existingJobs, 0),
      1,
    );
    assert.deepEqual(await counts(inspect), { jobs: 1, versions: 1, events: 1 });
  } finally {
    await inspect.end({ timeout: 2 });
  }

  console.log("Job discovery verified: provenance, duplicate scan idempotence, and rebuild");
} finally {
  await databaseClient?.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
