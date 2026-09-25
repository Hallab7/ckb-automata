import { createCkbClient } from "../packages/ccc/src/index.ts";
import {
  deploymentRegistry,
  inspectJobData,
  parseBlockNumber,
  parseHash32,
} from "../packages/core/src/index.ts";
import {
  DEADLINE_EXECUTOR_ADAPTER,
  RECURRING_EXECUTOR_ADAPTER,
  EligibilityEvaluator,
  ExecutorAdapterRegistry,
  PostgresEligibilityJobSource,
  chainScriptIdentity,
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

const network = required("CKB_NETWORK");
const genesisHash = parseHash32(required("CKB_GENESIS_HASH"));
const source = new PostgresEligibilityJobSource(required("DATABASE_URL"), network);
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
  const header = await client.getTipHeader();
  const tip = Object.freeze({
    hash: parseHash32(header.hash),
    number: parseBlockNumber(header.number.toString()),
    epoch: header.epoch.toString(),
    timestamp: header.timestamp.toString(),
  });
  const queued = [];
  const evaluator = new EligibilityEvaluator(
    loaded.deployment,
    new ExecutorAdapterRegistry([DEADLINE_EXECUTOR_ADAPTER, RECURRING_EXECUTOR_ADAPTER]),
    {
      async enqueue(queue, operation, idempotencyKey) {
        queued.push({ queue, operation, idempotencyKey });
        return { id: idempotencyKey };
      },
    },
  );
  const records = await source.listLiveJobs();
  const results = [];
  for (const record of records) {
    const live =
      record.policyKind === "deadline" ? await client.getCellLive(record.outPoint) : undefined;
    const observedPolicyScript =
      live?.cellOutput.type === undefined ? undefined : chainScriptIdentity(live.cellOutput.type);
    try {
      const result = await evaluator.evaluate(record, tip, 0, observedPolicyScript);
      results.push({ jobId: record.jobId, sequence: record.sequence, result });
    } catch (error) {
      const contract = loaded.deployment.contracts["recurring-policy"];
      const inspection = inspectJobData(record.data, {
        manifest: loaded.deployment.manifest,
        expectedGenesisHash: loaded.deployment.genesisHash,
        policyScript: observedPolicyScript ?? { ...contract.script, args: "0x" },
      });
      results.push({
        jobId: record.jobId,
        sequence: record.sequence,
        policyKind: record.policyKind,
        inspection:
          inspection.status === "ok"
            ? {
                status: inspection.status,
                jobId: inspection.job.jobId,
                sequence: inspection.job.sequence.toString(),
                policyKind: inspection.policy.kind,
              }
            : inspection,
        error: causes(error),
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify({ network, tip: tip.number.toString(), records: results, queued }, null, 2)}\n`,
  );
} finally {
  await Promise.all([source.close(), client.close()]);
}
