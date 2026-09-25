import { createCkbClient } from "../packages/ccc/src/index.ts";
import { deploymentRegistry, parseHash32, parseShannons } from "../packages/core/src/index.ts";
import {
  ChainBuildSnapshotSource,
  DEADLINE_EXECUTOR_ADAPTER,
  RECURRING_EXECUTOR_ADAPTER,
  ExecutorAdapterRegistry,
  PostgresBuildAttemptStore,
  PostgresEligibilityJobSource,
  runExecutorAdapter,
} from "../apps/executor/src/index.ts";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function causes(error) {
  const result = [];
  const seen = new Set();
  let current = error;
  while (current instanceof Error && !seen.has(current) && result.length < 6) {
    seen.add(current);
    result.push({
      name: current.name,
      message: current.message,
      ...(typeof current.code === "string" ? { code: current.code } : {}),
    });
    current = current.cause;
  }
  return result;
}

const jobId = parseHash32(process.argv[2]);
const sequence = process.argv[3] ?? "0";
const network = required("CKB_NETWORK");
const genesisHash = parseHash32(required("CKB_GENESIS_HASH"));
const source = new PostgresEligibilityJobSource(required("DATABASE_URL"), network);
const resolutions = new PostgresBuildAttemptStore(required("DATABASE_URL"), network);
const client = createCkbClient({
  rpcEndpoints: [required("CKB_RPC_URL")],
  indexerEndpoints: [required("CKB_INDEXER_URL")],
  timeoutMs: 10_000,
  safeReadAttempts: 3,
});

try {
  const loaded = await deploymentRegistry.load(genesisHash);
  if (loaded.status !== "ok" || loaded.deployment.network !== network) {
    throw new Error("executor deployment is unavailable for the configured network");
  }
  const record = await source.getLiveJob(jobId, sequence);
  if (!record) throw new Error("live job was not found in the canonical read model");
  const secp = loaded.deployment.manifest.secp256k1Blake160;
  const rewardLock = Object.freeze({
    codeHash: secp.codeHash,
    hashType: secp.hashType,
    args: required("EXECUTOR_LOCK_ARGS"),
  });
  const snapshot = await new ChainBuildSnapshotSource({
    deployment: loaded.deployment,
    runtime: client,
    rewardLock,
    resolutions,
  }).reload(record);
  if (!snapshot) throw new Error("live job snapshot could not be reconstructed");
  try {
    const result = runExecutorAdapter(
      new ExecutorAdapterRegistry([DEADLINE_EXECUTOR_ADAPTER, RECURRING_EXECUTOR_ADAPTER]),
      snapshot,
      {
        rewardLock,
        transactionFee: parseShannons(required("EXECUTOR_TRANSACTION_FEE")),
      },
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          jobId,
          sequence,
          snapshot: {
            applicationCells: snapshot.applicationCells.length,
            feeCells: snapshot.feeCells.length,
            payloads: snapshot.payloads.length,
            resolvedLocks: snapshot.resolvedLocks.length,
          },
          result,
        },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      )}\n`,
    );
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jobId, sequence, error: causes(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
} finally {
  await Promise.all([source.close(), resolutions.close(), client.close()]);
}
