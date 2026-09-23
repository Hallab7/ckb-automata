import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecurringCreation,
  deploymentRegistry,
  inspectJobData,
  parseBlockNumber,
  parseHash32,
  type RegisteredDeployment,
} from "@ckb-automata/core";

import { ExecutorAdapterRegistry } from "./adapter.ts";
import {
  MAX_EVALUATION_DELAY_MS,
  MIN_EVALUATION_DELAY_MS,
  EligibilityEvaluator,
  nextEvaluationDelay,
  type EligibilityJobRecord,
} from "./eligibility.ts";
import { RECURRING_EXECUTOR_ADAPTER } from "./policies/recurring.ts";

async function deployment(): Promise<RegisteredDeployment> {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("local deployment is unavailable");
  return loaded.deployment;
}

async function fixture() {
  const registered = await deployment();
  const creation = buildRecurringCreation({
    deployment: registered,
    ownerLockHash: parseHash32(`0x${"11".repeat(32)}`),
    recipientLockHash: parseHash32(`0x${"22".repeat(32)}`),
    amount: "10000000000",
    intervalBlocks: "10",
    firstNotBefore: "100",
    totalRuns: "2",
    reward: "10000000000",
    creatorNonce: "71",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "900" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const inspected = inspectJobData(creation.jobData, {
    manifest: registered.manifest,
    expectedGenesisHash: registered.genesisHash,
    policyScript: creation.transaction.outputs[0]?.type ?? undefined,
  });
  assert.equal(inspected.status, "ok");
  if (inspected.status !== "ok") throw new Error("fixture job is invalid");
  const output = creation.transaction.outputs[0];
  assert.ok(output);
  const record: EligibilityJobRecord = Object.freeze({
    networkId: registered.network,
    jobId: inspected.job.jobId,
    sequence: inspected.job.sequence.toString(),
    policyKind: "recurring",
    data: creation.jobData,
    capacity: BigInt(output.capacity).toString(),
    outPoint: Object.freeze({ txHash: parseHash32(`0x${"71".repeat(32)}`), index: "0" }),
    block: Object.freeze({ hash: parseHash32(`0x${"70".repeat(32)}`), number: "90" }),
  });
  return { registered, record };
}

function tip(number: bigint) {
  return Object.freeze({
    hash: parseHash32(`0x${number.toString(16).padStart(64, "0")}`),
    number: parseBlockNumber(number),
    epoch: "0x0" as const,
    timestamp: "0x0" as const,
  });
}

function queueFixture() {
  const calls: unknown[][] = [];
  return {
    calls,
    queues: {
      async enqueue(...arguments_: unknown[]) {
        calls.push(arguments_);
        return {} as never;
      },
    },
  };
}

test("live discovery enqueues stable evaluation work", async () => {
  const { registered, record } = await fixture();
  const queue = queueFixture();
  const evaluator = new EligibilityEvaluator(
    registered,
    new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
    queue.queues,
  );
  assert.equal(await evaluator.enqueueLiveJobs([record]), 1);
  assert.deepEqual(queue.calls, [
    [
      "evaluate",
      "evaluate-job",
      `${record.jobId}/${record.sequence}/wake-0`,
      { jobId: record.jobId, sequence: record.sequence, wakeSequence: 0 },
    ],
  ]);
});

test("chain tip below the bound only schedules another wake-up hint", async () => {
  const { registered, record } = await fixture();
  const queue = queueFixture();
  const evaluator = new EligibilityEvaluator(
    registered,
    new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
    queue.queues,
  );
  const originalNow = Date.now;
  Date.now = () => 9_000_000_000_000;
  try {
    const result = await evaluator.evaluate(record, tip(90n), 0);
    assert.deepEqual(result, {
      status: "waiting",
      jobId: record.jobId,
      sequence: record.sequence,
      observedTip: "90",
      notBefore: "100",
      delayMs: 40_000,
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(
    queue.calls.some(([name]) => name === "build"),
    false,
  );
  assert.deepEqual(queue.calls[0], [
    "evaluate",
    "evaluate-job",
    `${record.jobId}/${record.sequence}/wake-1`,
    { jobId: record.jobId, sequence: record.sequence, wakeSequence: 1 },
    { delay: 40_000 },
  ]);
});

test("only the chain tip reaching the bound moves work to build", async () => {
  const { registered, record } = await fixture();
  const queue = queueFixture();
  const evaluator = new EligibilityEvaluator(
    registered,
    new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
    queue.queues,
  );
  const result = await evaluator.evaluate(record, tip(100n), 0);
  assert.deepEqual(result, {
    status: "ready",
    jobId: record.jobId,
    sequence: record.sequence,
    adapterId: "recurring-v1",
    observedTip: "100",
  });
  assert.equal(queue.calls[0]?.[0], "build");
  assert.deepEqual(queue.calls[0]?.[4], undefined);
});

test("wake-up estimates are bounded and indexed data must match its commitment", async () => {
  assert.equal(nextEvaluationDelay(10n, 10n), MIN_EVALUATION_DELAY_MS);
  assert.equal(nextEvaluationDelay(1_000_000n, 1n), MAX_EVALUATION_DELAY_MS);
  const { registered, record } = await fixture();
  const evaluator = new EligibilityEvaluator(
    registered,
    new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
    queueFixture().queues,
  );
  await assert.rejects(
    evaluator.evaluate({ ...record, sequence: "1" }, tip(100n), 0),
    /does not match/,
  );
});

test("each waiting evaluation advances its durable wake identity", async () => {
  const { registered, record } = await fixture();
  const queue = queueFixture();
  const evaluator = new EligibilityEvaluator(
    registered,
    new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
    queue.queues,
  );
  await evaluator.evaluate(record, tip(90n), 41);
  assert.deepEqual(queue.calls[0], [
    "evaluate",
    "evaluate-job",
    `${record.jobId}/${record.sequence}/wake-42`,
    { jobId: record.jobId, sequence: record.sequence, wakeSequence: 42 },
    { delay: 40_000 },
  ]);
});
