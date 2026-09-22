import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildRecurringCreation,
  deploymentRegistry,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseShannons,
  type RegisteredDeployment,
  type ScriptIdentity,
} from "@ckb-automata/core";

import {
  ExecutorAdapterError,
  ExecutorAdapterRegistry,
  defineExecutorAdapter,
  runExecutorAdapter,
  type ExecutorPolicyAdapter,
  type ExecutorSnapshot,
} from "./adapter.ts";
import { DEADLINE_EXECUTOR_REGISTRATION } from "./policies/deadline.ts";
import { RECURRING_EXECUTOR_REGISTRATION } from "./policies/recurring.ts";

async function deployment(): Promise<RegisteredDeployment> {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("local deployment is unavailable");
  return loaded.deployment;
}

function ownerLock(value: RegisteredDeployment): ScriptIdentity {
  return {
    codeHash: value.manifest.secp256k1Blake160.codeHash,
    hashType: value.manifest.secp256k1Blake160.hashType,
    args: value.manifest.fixtureWallet.lockArg,
  };
}

function header(number: bigint) {
  return Object.freeze({
    hash: parseHash32(`0x${number.toString(16).padStart(64, "0")}`),
    number: parseBlockNumber(number),
    epoch: "0x0" as const,
    timestamp: `0x${(number * 1_000n).toString(16)}` as const,
  });
}

async function recurringSnapshot(): Promise<{
  readonly snapshot: ExecutorSnapshot;
  readonly rewardLock: ScriptIdentity;
  readonly transaction: ReturnType<typeof buildRecurringCreation>["transaction"];
}> {
  const registered = await deployment();
  const rewardLock = ownerLock(registered);
  const creation = buildRecurringCreation({
    deployment: registered,
    ownerLockHash: parseHash32(`0x${"11".repeat(32)}`),
    recipientLockHash: parseHash32(`0x${"22".repeat(32)}`),
    amount: "10000000000",
    intervalBlocks: "10",
    firstNotBefore: "100",
    totalRuns: "2",
    reward: "10000000000",
    creatorNonce: "49",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "900" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const output = creation.transaction.outputs[0];
  assert.ok(output);
  const jobHeader = header(90n);
  return {
    rewardLock,
    transaction: creation.transaction,
    snapshot: Object.freeze({
      deployment: registered,
      tip: header(100n),
      job: Object.freeze({
        outPoint: parseOutPoint({ txHash: `0x${"49".repeat(32)}`, index: "0" }),
        output,
        data: creation.jobData,
        blockHash: jobHeader.hash,
        blockNumber: jobHeader.number,
      }),
      applicationCells: Object.freeze([]),
      feeCells: Object.freeze([]),
      headers: Object.freeze([jobHeader]),
      resolvedLocks: Object.freeze([]),
      payloads: Object.freeze([]),
      claims: Object.freeze({}),
    }),
  };
}

test("identical snapshot and executor identity produce identical policy outputs", async () => {
  const fixture = await recurringSnapshot();
  const adapter = defineExecutorAdapter({
    registration: RECURRING_EXECUTOR_REGISTRATION,
    inspect: (context) =>
      Object.freeze({
        jobId: context.jobInspection.job.jobId,
        sequence: context.jobInspection.job.sequence,
        tip: context.snapshot.tip.hash,
      }),
    eligibility: (context, inspection) => ({
      status: "eligible" as const,
      evidence: Object.freeze({
        tip: inspection.tip,
        rewardLock: context.identity.rewardLock,
      }),
    }),
    build: (_context, inspection, eligibility) => ({
      transaction: fixture.transaction,
      summary: Object.freeze({ inspection, evidence: eligibility.evidence }),
    }),
    verifyBuilt: (_context, inspection, eligibility, build) => {
      if (
        build.summary["inspection"] === inspection &&
        build.summary["evidence"] === eligibility.evidence
      ) {
        return { status: "valid" as const };
      }
      return {
        status: "invalid" as const,
        reason: "EXECUTOR_SIMULATION_REJECTED" as const,
        message: "build inputs changed",
      };
    },
  } satisfies ExecutorPolicyAdapter<
    { readonly jobId: string; readonly sequence: bigint; readonly tip: string },
    { readonly tip: string; readonly rewardLock: ScriptIdentity }
  >);
  const registry = new ExecutorAdapterRegistry([adapter]);
  const first = runExecutorAdapter(registry, fixture.snapshot, {
    rewardLock: fixture.rewardLock,
    transactionFee: parseShannons("1000000"),
  });
  const second = runExecutorAdapter(registry, fixture.snapshot, {
    rewardLock: fixture.rewardLock,
    transactionFee: parseShannons("1000000"),
  });
  assert.deepEqual(first, second);
  assert.equal(first.status, "built");
  assert.equal(first.adapterId, "recurring-v1");
});

test("deadline and recurring registrations own their policy matching", () => {
  const hash = parseHash32(`0x${"44".repeat(32)}`);
  assert.equal(
    DEADLINE_EXECUTOR_REGISTRATION.supports({
      kind: "deadline",
      scriptHash: hash,
      contract: "deadline-policy",
      campaignTypeHash: hash,
    }),
    true,
  );
  assert.equal(
    DEADLINE_EXECUTOR_REGISTRATION.supports({
      kind: "recurring",
      scriptHash: hash,
      contract: "recurring-policy",
    }),
    false,
  );
  assert.equal(
    RECURRING_EXECUTOR_REGISTRATION.supports({
      kind: "recurring",
      scriptHash: hash,
      contract: "recurring-policy",
    }),
    true,
  );
});

test("ineligible decisions stop before build", async () => {
  const fixture = await recurringSnapshot();
  let builds = 0;
  const adapter = defineExecutorAdapter({
    registration: RECURRING_EXECUTOR_REGISTRATION,
    inspect: () => Object.freeze({ observed: true }),
    eligibility: () => ({
      status: "ineligible" as const,
      reason: "EXECUTOR_NOT_YET_ELIGIBLE" as const,
      terminal: false,
      evidence: Object.freeze({ tip: fixture.snapshot.tip.number }),
    }),
    build: () => {
      builds += 1;
      return { transaction: fixture.transaction, summary: Object.freeze({}) };
    },
    verifyBuilt: () => ({ status: "valid" as const }),
  });
  const result = runExecutorAdapter(new ExecutorAdapterRegistry([adapter]), fixture.snapshot, {
    rewardLock: fixture.rewardLock,
    transactionFee: parseShannons("1000000"),
  });
  assert.equal(result.status, "ineligible");
  assert.equal(builds, 0);
});

test("the registry rejects ambiguous support and exposes failed self-verification", async () => {
  const fixture = await recurringSnapshot();
  const invalid = defineExecutorAdapter({
    registration: RECURRING_EXECUTOR_REGISTRATION,
    inspect: () => null,
    eligibility: () => ({ status: "eligible" as const, evidence: null }),
    build: () => ({ transaction: fixture.transaction, summary: Object.freeze({}) }),
    verifyBuilt: () => ({
      status: "invalid" as const,
      reason: "EXECUTOR_SIMULATION_REJECTED" as const,
      message: "fixture rejected",
    }),
  });
  const result = runExecutorAdapter(new ExecutorAdapterRegistry([invalid]), fixture.snapshot, {
    rewardLock: fixture.rewardLock,
    transactionFee: parseShannons("1000000"),
  });
  assert.equal(result.status, "invalid_build");
  assert.equal(result.verification.reason, "EXECUTOR_SIMULATION_REJECTED");

  const duplicateSupport = defineExecutorAdapter({
    registration: { ...RECURRING_EXECUTOR_REGISTRATION, id: "also-recurring" },
    inspect: () => null,
    eligibility: () => ({ status: "eligible" as const, evidence: null }),
    build: () => ({ transaction: fixture.transaction, summary: Object.freeze({}) }),
    verifyBuilt: () => ({ status: "valid" as const }),
  });
  assert.throws(
    () =>
      runExecutorAdapter(
        new ExecutorAdapterRegistry([invalid, duplicateSupport]),
        fixture.snapshot,
        { rewardLock: fixture.rewardLock, transactionFee: parseShannons("1000000") },
      ),
    (error: unknown) =>
      error instanceof ExecutorAdapterError && error.code === "UNSUPPORTED_POLICY",
  );
});

test("the shared executor layer contains no policy-specific dispatch", async () => {
  const source = await readFile(new URL("./adapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /policy\.kind\s*===/);
});
