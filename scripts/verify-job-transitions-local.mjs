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
import { JobCellDiscovery } from "../apps/api/src/indexer/job-discovery.ts";
import { JobTransitionIndexer } from "../apps/api/src/indexer/job-transitions.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const shellModule = await import(pathToFileURL(requireFromApi.resolve("@ckb-ccc/shell")).href);
const { WitnessArgs } = shellModule.default ?? shellModule;
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for transition verification");

const databaseName = `automata_transitions_${randomBytes(6).toString("hex")}`;
if (!/^automata_transitions_[0-9a-f]{12}$/.test(databaseName)) {
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
const initialTxHash = `0x${"10".repeat(32)}`;
const initialBlockHash = `0x${"42".repeat(32)}`;
const transitionBlockHash = `0x${"43".repeat(32)}`;
const base = JobDataV1.unpack(Buffer.from(fixture.expected.job_data.slice(2), "hex"));

function hex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function jobData(id, overrides = {}) {
  return hex(
    JobDataV1.pack({
      ...base,
      job_id: Array(32).fill(id),
      ...overrides,
    }),
  );
}

function output(capacity = 20_000_000_000n) {
  return {
    capacity,
    lock: { ...deployment.contracts["job-lock"].script, args: "0x" },
    type: { ...deployment.contracts["recurring-policy"].script, args: "0x" },
  };
}

function witness(inputType) {
  return WitnessArgs.from({ inputType }).toHex();
}

const executeWitness = witness(`0x00${"00000000"}${"11".repeat(32)}01${"00000000"}`);
const initialData = [
  jobData(1, { remaining_runs: 1 }),
  jobData(2, { remaining_runs: 3 }),
  jobData(3),
  jobData(4),
  jobData(5),
  jobData(6),
];
const initialBlock = {
  header: { number: 42n, hash: initialBlockHash, timestamp: 1_800_000_000_000n },
  transactions: [
    {
      hash: () => initialTxHash,
      inputs: [],
      outputs: initialData.map(() => output()),
      outputsData: initialData,
      witnesses: [],
    },
  ],
};
const recurringSuccessor = jobData(2, {
  sequence: 1n,
  remaining_runs: 2,
  remaining_budget: BigInt(base.remaining_budget) - BigInt(base.reward),
});
const topUpSuccessor = jobData(6, {
  remaining_budget: BigInt(base.remaining_budget) + 1_000_000_000n,
});
const cases = [
  { witness: executeWitness, outputs: [], outputsData: [] },
  {
    witness: executeWitness,
    outputs: [output()],
    outputsData: [recurringSuccessor],
  },
  { witness: witness("0x01"), outputs: [], outputsData: [] },
  { witness: witness("0x02"), outputs: [], outputsData: [] },
  { witness: "0x", outputs: [], outputsData: [] },
  {
    witness: witness("0x0300000000"),
    outputs: [output(21_000_000_000n)],
    outputsData: [topUpSuccessor],
  },
];
const transitionBlock = {
  header: { number: 43n, hash: transitionBlockHash, timestamp: 1_800_000_010_000n },
  transactions: cases.map((fixtureCase, index) => ({
    hash: () => `0x${(32 + index).toString(16).padStart(2, "0").repeat(32)}`,
    inputs: [{ previousOutput: { txHash: initialTxHash, index: BigInt(index) } }],
    outputs: fixtureCase.outputs,
    outputsData: fixtureCase.outputsData,
    witnesses: [fixtureCase.witness],
  })),
};
const blocks = new Map([
  [42n, initialBlock],
  [43n, transitionBlock],
]);

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
  const ckbClient = { getBlockByNumber: async (number) => blocks.get(BigInt(number)) };
  const discovery = new JobCellDiscovery(databaseClient.database, ckbClient);
  const transitions = new JobTransitionIndexer(databaseClient.database, ckbClient);

  async function replay() {
    await discovery.scanBlock(42n, deployment);
    await discovery.scanBlock(43n, deployment);
    return transitions.scanBlock(43n, deployment);
  }

  const result = await replay();
  assert.deepEqual(result, {
    indexedTransitions: 6,
    terminalTransitions: 4,
    successorTransitions: 2,
    consumedByOther: 1,
  });

  const inspect = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  try {
    assert.deepEqual(await counts(inspect), { jobs: 6, versions: 8, events: 12 });
    const eventTypes = (
      await inspect`
        SELECT event_type
        FROM job_events
        WHERE event_type <> 'job_discovered'
        ORDER BY event_type
      `
    ).map(({ event_type }) => event_type);
    assert.deepEqual(eventTypes, [
      "job_cancelled",
      "job_consumed_by_other",
      "job_one_shot",
      "job_recovered",
      "job_recurring",
      "job_topped_up",
    ]);
    const [agreement] = await inspect`
      SELECT count(*)::integer AS mismatches
      FROM jobs current
      LEFT JOIN job_versions history
        ON history.network_id = current.network_id
       AND history.job_id = current.job_id
       AND history.outpoint_tx_hash = current.outpoint_tx_hash
       AND history.outpoint_index = current.outpoint_index
       AND history.status = current.state
      WHERE history.id IS NULL
    `;
    assert.equal(agreement.mismatches, 0);
    const duplicate = await transitions.scanBlock(43n, deployment);
    assert.equal(duplicate.indexedTransitions, 0);
    assert.deepEqual(await counts(inspect), { jobs: 6, versions: 8, events: 12 });

    await inspect`DELETE FROM jobs WHERE network_id = ${deployment.network}`;
    assert.deepEqual(await counts(inspect), { jobs: 0, versions: 0, events: 0 });
    assert.equal((await replay()).indexedTransitions, 6);
    assert.deepEqual(await counts(inspect), { jobs: 6, versions: 8, events: 12 });
    const [duplicateSequence] = await inspect`
      SELECT count(*)::integer AS versions
      FROM job_versions
      WHERE job_id = ${`0x${"06".repeat(32)}`} AND sequence = 0
    `;
    assert.equal(duplicateSequence.versions, 2);
  } finally {
    await inspect.end({ timeout: 2 });
  }

  console.log("Job transitions verified: terminal paths, successors, history, and replay");
} finally {
  await databaseClient?.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
