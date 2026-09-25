import { randomUUID } from "node:crypto";

import { rawTransactionToHash, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, parseSequence, type Hash32 } from "@ckb-automata/core";

import {
  runExecutorAdapter,
  type ExecutorAdapterRegistry,
  type ExecutorIdentity,
  type ExecutorSnapshot,
} from "./adapter.ts";
import type {
  BuildQueuePayload,
  EligibilityJobRecord,
  EligibilityQueuePayload,
} from "./eligibility.ts";
import type { DurableQueueRegistry } from "./queues.ts";
import { executorFailureCode } from "./retry.ts";

export const BUILD_CLAIM_LEASE_MS = 5 * 60_000;

export interface BuildAttemptClaim {
  readonly attemptId: string;
  readonly claimToken: string;
  readonly record: EligibilityJobRecord;
}

export type BuildClaimResult =
  | { readonly status: "claimed"; readonly claim: BuildAttemptClaim }
  | {
      readonly status: "duplicate";
      readonly attemptId: string;
      readonly intentHash?: Hash32;
      readonly builderLockHash?: Hash32;
    }
  | { readonly status: "stale" };

export interface BuildAttemptStore {
  claim(payload: BuildQueuePayload, builderLockHash: Hash32): Promise<BuildClaimResult>;
  complete(
    claim: BuildAttemptClaim,
    snapshot: Readonly<Record<string, unknown>>,
    intentHash: Hash32,
    transaction: Readonly<Record<string, unknown>>,
  ): Promise<boolean>;
  fail(
    claim: BuildAttemptClaim,
    state: "conflicted" | "recovery_required",
    errorCode: string,
  ): Promise<void>;
}

export interface BuildSnapshotSource {
  reload(record: EligibilityJobRecord): Promise<ExecutorSnapshot | undefined>;
}

type BuildQueues = Pick<DurableQueueRegistry, "enqueue">;

export type TransactionBuildResult =
  | { readonly status: "built"; readonly attemptId: string; readonly intentHash: Hash32 }
  | {
      readonly status: "duplicate";
      readonly attemptId: string;
      readonly intentHash?: Hash32;
    }
  | { readonly status: "stale" }
  | { readonly status: "ineligible"; readonly attemptId: string; readonly reason: string };

function canonicalRecord(value: unknown): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("build evidence must serialize to an object");
  }
  return Object.freeze(parsed as Record<string, unknown>);
}

function sameOutPoint(record: EligibilityJobRecord, snapshot: ExecutorSnapshot): boolean {
  return (
    snapshot.job.outPoint.txHash === record.outPoint.txHash &&
    snapshot.job.outPoint.index === BigInt(record.outPoint.index) &&
    snapshot.job.data === record.data
  );
}

function errorCode(error: unknown): string {
  return executorFailureCode(error) ?? "EXECUTOR_BUILD_FAILED";
}

export class TransactionBuildService {
  readonly #registry: ExecutorAdapterRegistry;
  readonly #identity: ExecutorIdentity;
  readonly #store: BuildAttemptStore;
  readonly #source: BuildSnapshotSource;
  readonly #queues: BuildQueues;

  constructor(options: {
    readonly registry: ExecutorAdapterRegistry;
    readonly identity: ExecutorIdentity;
    readonly store: BuildAttemptStore;
    readonly source: BuildSnapshotSource;
    readonly queues: BuildQueues;
  }) {
    this.#registry = options.registry;
    this.#identity = options.identity;
    this.#store = options.store;
    this.#source = options.source;
    this.#queues = options.queues;
  }

  async build(payload: BuildQueuePayload): Promise<TransactionBuildResult> {
    const builderLockHash = parseHash32(scriptToHash(this.#identity.rewardLock));
    const canonicalPayload = Object.freeze({
      ...payload,
      jobId: parseHash32(payload.jobId),
      sequence: parseSequence(payload.sequence).toString(),
      evaluatedAt: Object.freeze({
        blockHash: parseHash32(payload.evaluatedAt.blockHash),
        blockNumber: payload.evaluatedAt.blockNumber,
      }),
    });
    const claimed = await this.#store.claim(canonicalPayload, builderLockHash);
    if (claimed.status === "stale") return Object.freeze({ status: "stale" });
    if (claimed.status === "duplicate") {
      if (claimed.intentHash !== undefined && claimed.builderLockHash === builderLockHash) {
        await this.#enqueueSimulation(claimed.attemptId, claimed.intentHash);
      }
      return Object.freeze({
        status: "duplicate",
        attemptId: claimed.attemptId,
        ...(claimed.intentHash === undefined ? {} : { intentHash: claimed.intentHash }),
      });
    }

    const { claim } = claimed;
    try {
      const snapshot = await this.#source.reload(claim.record);
      if (!snapshot || !sameOutPoint(claim.record, snapshot)) {
        await this.#store.fail(claim, "conflicted", "EXECUTOR_STALE_OUTPOINT");
        return Object.freeze({ status: "stale" });
      }
      const execution = runExecutorAdapter(this.#registry, snapshot, this.#identity);
      if (execution.adapterId !== canonicalPayload.adapterId) {
        throw Object.assign(new Error("eligibility and build adapters disagree"), {
          code: "EXECUTOR_ADAPTER_MISMATCH",
        });
      }
      if (execution.status === "ineligible") {
        await this.#store.fail(claim, "recovery_required", execution.eligibility.reason);
        await this.#queues.enqueue<EligibilityQueuePayload>(
          "evaluate",
          "evaluate-job",
          `${claim.record.jobId}/${claim.record.sequence}/recheck-${claim.attemptId}`,
          Object.freeze({
            jobId: claim.record.jobId,
            sequence: claim.record.sequence,
            wakeSequence: 0,
          }),
        );
        return Object.freeze({
          status: "ineligible",
          attemptId: claim.attemptId,
          reason: execution.eligibility.reason,
        });
      }
      if (execution.status === "invalid_build") {
        throw Object.assign(new Error("adapter self-verification rejected its transaction"), {
          code: execution.verification.reason,
        });
      }
      const intentHash = parseHash32(
        rawTransactionToHash(
          execution.build.transaction as unknown as Parameters<typeof rawTransactionToHash>[0],
        ),
      );
      const completed = await this.#store.complete(
        claim,
        canonicalRecord(snapshot),
        intentHash,
        canonicalRecord(execution.build.transaction),
      );
      if (!completed) {
        throw Object.assign(new Error("build claim expired before completion"), {
          code: "EXECUTOR_BUILD_CLAIM_LOST",
        });
      }
      await this.#enqueueSimulation(claim.attemptId, intentHash);
      return Object.freeze({ status: "built", attemptId: claim.attemptId, intentHash });
    } catch (error) {
      await this.#store.fail(claim, "recovery_required", errorCode(error));
      throw error;
    }
  }

  #enqueueSimulation(attemptId: string, intentHash: Hash32): Promise<unknown> {
    return this.#queues.enqueue(
      "submit",
      "dry-run-transaction",
      attemptId,
      Object.freeze({ attemptId, intentHash }),
    );
  }
}

export function createBuildAttemptId(): string {
  return randomUUID();
}
