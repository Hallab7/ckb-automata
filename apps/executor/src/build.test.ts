import assert from "node:assert/strict";
import test from "node:test";

import { JobDataV1 } from "@ckb-automata/molecule";
import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  CONTRACT_CAPACITY,
  buildRecurringCreation,
  deploymentRegistry,
  deriveAbsoluteBlockTriggerHash,
  inspectJobData,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseShannons,
  toRpcHex,
  type RegisteredDeployment,
  type ScriptIdentity,
  type Hash32,
} from "@ckb-automata/core";

import { ExecutorAdapterRegistry, type ExecutorSnapshot } from "./adapter.ts";
import {
  TransactionBuildService,
  type BuildAttemptClaim,
  type BuildAttemptStore,
  type BuildClaimResult,
} from "./build.ts";
import type { BuildQueuePayload, EligibilityJobRecord } from "./eligibility.ts";
import { RECURRING_EXECUTOR_ADAPTER } from "./policies/recurring.ts";

async function deployment(): Promise<RegisteredDeployment> {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("local deployment is unavailable");
  return loaded.deployment;
}

function lock(value: RegisteredDeployment, byte: string): ScriptIdentity {
  return Object.freeze({
    codeHash: value.manifest.secp256k1Blake160.codeHash,
    hashType: value.manifest.secp256k1Blake160.hashType,
    args: `0x${byte.repeat(40)}`,
  });
}

function header(number: bigint) {
  return Object.freeze({
    hash: parseHash32(`0x${number.toString(16).padStart(64, "0")}`),
    number: parseBlockNumber(number),
    epoch: "0x0" as const,
    timestamp: "0x0" as const,
  });
}

async function fixture(): Promise<{
  readonly record: EligibilityJobRecord;
  readonly snapshot: ExecutorSnapshot;
  readonly executorLock: ScriptIdentity;
}> {
  const registered = await deployment();
  const ownerLock = lock(registered, "11");
  const recipientLock = lock(registered, "22");
  const executorLock = lock(registered, "33");
  const creation = buildRecurringCreation({
    deployment: registered,
    ownerLockHash: parseHash32(scriptToHash(ownerLock)),
    recipientLockHash: parseHash32(scriptToHash(recipientLock)),
    amount: "10000000000",
    intervalBlocks: "10",
    firstNotBefore: "100",
    totalRuns: "2",
    reward: "10000000000",
    creatorNonce: "72",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "900" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const initial = JobDataV1.unpack(hexToBytes(creation.jobData));
  const jobData = bytesToHex(
    JobDataV1.pack({
      ...initial,
      trigger_params_hash: [
        ...deriveAbsoluteBlockTriggerHash(parseBlockNumber(initial.not_before.toString())),
      ],
    }),
  ) as `0x${string}`;
  const output = creation.transaction.outputs[0]!;
  const inspected = inspectJobData(jobData, {
    manifest: registered.manifest,
    expectedGenesisHash: registered.genesisHash,
    policyScript: output.type ?? undefined,
  });
  assert.equal(inspected.status, "ok");
  if (inspected.status !== "ok") throw new Error("fixture job is invalid");
  const jobOutPoint = parseOutPoint({ txHash: `0x${"72".repeat(32)}`, index: "0" });
  const createdAt = header(90n);
  const capacity = parseShannons(CONTRACT_CAPACITY.jobCellV1 + 40_000_000_000n);
  const record = Object.freeze({
    networkId: registered.network,
    jobId: inspected.job.jobId,
    sequence: "0",
    policyKind: "recurring" as const,
    data: jobData,
    capacity: capacity.toString(),
    outPoint: Object.freeze({ txHash: jobOutPoint.txHash, index: "0" }),
    block: Object.freeze({ hash: createdAt.hash, number: "90" }),
  });
  return {
    record,
    executorLock,
    snapshot: Object.freeze({
      deployment: registered,
      tip: header(100n),
      job: Object.freeze({
        outPoint: jobOutPoint,
        output: Object.freeze({ ...output, capacity: toRpcHex(capacity) }),
        data: jobData,
        blockHash: createdAt.hash,
        blockNumber: createdAt.number,
      }),
      applicationCells: Object.freeze([]),
      feeCells: Object.freeze([
        Object.freeze({
          outPoint: parseOutPoint({ txHash: `0x${"73".repeat(32)}`, index: "0" }),
          output: Object.freeze({
            capacity: "0x2540be400" as const,
            lock: executorLock,
            type: null,
          }),
          data: "0x" as const,
          blockHash: createdAt.hash,
          blockNumber: createdAt.number,
        }),
      ]),
      headers: Object.freeze([]),
      resolvedLocks: Object.freeze([ownerLock, recipientLock]),
      payloads: Object.freeze([creation.recurringPayload]),
      claims: Object.freeze({}),
    }),
  };
}

class MemoryStore implements BuildAttemptStore {
  readonly claimValue: BuildAttemptClaim;
  builderLockHash: Hash32 | undefined;
  completed:
    | {
        readonly snapshot: Readonly<Record<string, unknown>>;
        readonly intentHash: string;
        readonly transaction: Readonly<Record<string, unknown>>;
      }
    | undefined;
  failed: { readonly state: string; readonly code: string } | undefined;

  constructor(record: EligibilityJobRecord) {
    this.claimValue = Object.freeze({
      attemptId: "00000000-0000-4000-8000-000000000072",
      claimToken: "00000000-0000-4000-8000-000000000073",
      record,
    });
  }

  async claim(_payload: BuildQueuePayload, builderLockHash: Hash32): Promise<BuildClaimResult> {
    if (this.completed) {
      return Object.freeze({
        status: "duplicate",
        attemptId: this.claimValue.attemptId,
        intentHash: parseHash32(this.completed.intentHash),
        ...(this.builderLockHash === undefined ? {} : { builderLockHash: this.builderLockHash }),
      });
    }
    this.builderLockHash = builderLockHash;
    return Object.freeze({ status: "claimed", claim: this.claimValue });
  }

  async complete(
    _claim: BuildAttemptClaim,
    snapshot: Readonly<Record<string, unknown>>,
    intentHash: Hash32,
    transaction: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    this.completed = { snapshot, intentHash, transaction };
    return true;
  }

  async fail(
    _claim: BuildAttemptClaim,
    state: "conflicted" | "recovery_required",
    code: string,
  ): Promise<void> {
    this.failed = { state, code };
  }
}

function payload(record: EligibilityJobRecord): BuildQueuePayload {
  return Object.freeze({
    jobId: record.jobId,
    sequence: record.sequence,
    adapterId: "recurring-v1",
    evaluatedAt: Object.freeze({ blockHash: header(100n).hash, blockNumber: "100" }),
  });
}

test("build work records its exact snapshot and intent before simulation", async () => {
  const value = await fixture();
  const store = new MemoryStore(value.record);
  const calls: unknown[][] = [];
  const service = new TransactionBuildService({
    registry: new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
    identity: { rewardLock: value.executorLock, transactionFee: parseShannons("1000000") },
    store,
    source: {
      async reload() {
        return value.snapshot;
      },
    },
    queues: {
      async enqueue(...args: unknown[]) {
        calls.push(args);
        return {} as never;
      },
    },
  });
  const result = await service.build(payload(value.record));
  assert.equal(result.status, "built");
  assert.ok(store.completed);
  assert.equal(store.completed.snapshot["tip"] instanceof Object, true);
  const transaction = store.completed.transaction;
  assert.equal(Array.isArray(transaction["inputs"]), true);
  assert.equal((transaction["inputs"] as unknown[]).length, 2);
  assert.match(store.completed.intentHash, /^0x[0-9a-f]{64}$/);
  const firstCall = calls[0];
  assert.ok(firstCall);
  assert.equal(firstCall[0], "submit");
  assert.equal((firstCall[3] as { intentHash: string }).intentHash, store.completed.intentHash);

  const duplicate = await service.build(payload(value.record));
  assert.equal(duplicate.status, "duplicate");
  assert.equal(calls.length, 2);

  const otherOperator = new TransactionBuildService({
    registry: new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
    identity: {
      rewardLock: lock(value.snapshot.deployment, "44"),
      transactionFee: parseShannons("1000000"),
    },
    store,
    source: {
      async reload() {
        throw new Error("duplicate builds must not reload the chain snapshot");
      },
    },
    queues: {
      async enqueue(...args: unknown[]) {
        calls.push(args);
        return {} as never;
      },
    },
  });
  const crossOperatorDuplicate = await otherOperator.build(payload(value.record));
  assert.equal(crossOperatorDuplicate.status, "duplicate");
  assert.equal(calls.length, 2);
});

test("a stale outpoint closes the claim without producing a transaction", async () => {
  const value = await fixture();
  const store = new MemoryStore(value.record);
  let enqueued = false;
  const service = new TransactionBuildService({
    registry: new ExecutorAdapterRegistry([RECURRING_EXECUTOR_ADAPTER]),
    identity: { rewardLock: value.executorLock, transactionFee: parseShannons("1000000") },
    store,
    source: {
      async reload() {
        return undefined;
      },
    },
    queues: {
      async enqueue() {
        enqueued = true;
        return {} as never;
      },
    },
  });
  assert.deepEqual(await service.build(payload(value.record)), { status: "stale" });
  assert.deepEqual(store.failed, { state: "conflicted", code: "EXECUTOR_STALE_OUTPOINT" });
  assert.equal(store.completed, undefined);
  assert.equal(enqueued, false);
});
