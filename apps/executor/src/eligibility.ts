import {
  inspectJobData,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseSequence,
  parseShannons,
  type RegisteredDeployment,
  type ScriptIdentity,
} from "@ckb-automata/core";

import {
  evaluateExecutorEligibility,
  type ExecutorAdapterRegistry,
  type ExecutorHeaderSnapshot,
  type ExecutorSnapshot,
} from "./adapter.ts";
import type { DurableQueueRegistry } from "./queues.ts";

export const TARGET_BLOCK_INTERVAL_MS = 4_000;
export const MIN_EVALUATION_DELAY_MS = 1_000;
export const MAX_EVALUATION_DELAY_MS = 5 * 60_000;

export interface EligibilityJobRecord {
  readonly networkId: string;
  readonly jobId: string;
  readonly sequence: string;
  readonly policyKind: "deadline" | "recurring";
  readonly data: `0x${string}`;
  readonly capacity: string;
  readonly outPoint: { readonly txHash: string; readonly index: string };
  readonly block: { readonly hash: string; readonly number: string };
}

export interface EligibilityQueuePayload {
  readonly jobId: string;
  readonly sequence: string;
  readonly wakeSequence: number;
}

export interface BuildQueuePayload {
  readonly jobId: string;
  readonly sequence: string;
  readonly adapterId: string;
  readonly evaluatedAt: { readonly blockHash: string; readonly blockNumber: string };
}

export type EligibilityEvaluationResult =
  | {
      readonly status: "ready";
      readonly jobId: string;
      readonly sequence: string;
      readonly adapterId: string;
      readonly observedTip: string;
    }
  | {
      readonly status: "waiting";
      readonly jobId: string;
      readonly sequence: string;
      readonly observedTip: string;
      readonly notBefore: string;
      readonly delayMs: number;
    }
  | {
      readonly status: "terminal";
      readonly jobId: string;
      readonly sequence: string;
      readonly reason: string;
    };

type EligibilityQueues = Pick<DurableQueueRegistry, "enqueue">;

export function nextEvaluationDelay(notBefore: bigint, observedTip: bigint): number {
  if (notBefore <= observedTip) return MIN_EVALUATION_DELAY_MS;
  const remaining = notBefore - observedTip;
  const estimate = remaining * BigInt(TARGET_BLOCK_INTERVAL_MS);
  return Number(
    estimate > BigInt(MAX_EVALUATION_DELAY_MS)
      ? MAX_EVALUATION_DELAY_MS
      : estimate < BigInt(MIN_EVALUATION_DELAY_MS)
        ? MIN_EVALUATION_DELAY_MS
        : estimate,
  );
}

function policyScript(
  record: EligibilityJobRecord,
  deployment: RegisteredDeployment,
  observed?: ScriptIdentity,
) {
  if (observed !== undefined) return observed;
  if (record.policyKind === "deadline") {
    throw new Error("deadline eligibility requires the live policy script");
  }
  const contract = deployment.contracts["recurring-policy"];
  return Object.freeze({ ...contract.script, args: "0x" as const });
}

function snapshot(
  record: EligibilityJobRecord,
  tip: ExecutorHeaderSnapshot,
  deployment: RegisteredDeployment,
  observedPolicyScript?: ScriptIdentity,
): ExecutorSnapshot {
  return Object.freeze({
    deployment,
    tip,
    job: Object.freeze({
      outPoint: parseOutPoint(record.outPoint),
      output: Object.freeze({
        capacity: `0x${parseShannons(record.capacity).toString(16)}` as const,
        lock: Object.freeze({ ...deployment.contracts["job-lock"].script, args: "0x" as const }),
        type: policyScript(record, deployment, observedPolicyScript),
      }),
      data: record.data,
      blockHash: parseHash32(record.block.hash),
      blockNumber: parseBlockNumber(record.block.number),
    }),
    applicationCells: Object.freeze([]),
    feeCells: Object.freeze([]),
    headers: Object.freeze([]),
    resolvedLocks: Object.freeze([]),
    payloads: Object.freeze([]),
    claims: Object.freeze({}),
  });
}

function identity(record: EligibilityJobRecord): string {
  return `${record.jobId}/${record.sequence}`;
}

export class EligibilityEvaluator {
  readonly #deployment: RegisteredDeployment;
  readonly #registry: ExecutorAdapterRegistry;
  readonly #queues: EligibilityQueues;

  constructor(
    deployment: RegisteredDeployment,
    registry: ExecutorAdapterRegistry,
    queues: EligibilityQueues,
  ) {
    this.#deployment = deployment;
    this.#registry = registry;
    this.#queues = queues;
  }

  async enqueueLiveJobs(records: readonly EligibilityJobRecord[]): Promise<number> {
    for (const record of records) {
      if (record.networkId !== this.#deployment.network) {
        throw new Error("live job belongs to another network");
      }
      await this.#queues.enqueue(
        "evaluate",
        "evaluate-job",
        `${identity(record)}/wake-0`,
        Object.freeze({ jobId: record.jobId, sequence: record.sequence, wakeSequence: 0 }),
      );
    }
    return records.length;
  }

  async evaluate(
    record: EligibilityJobRecord,
    tip: ExecutorHeaderSnapshot,
    wakeSequence: number,
    observedPolicyScript?: ScriptIdentity,
  ): Promise<EligibilityEvaluationResult> {
    if (!Number.isSafeInteger(wakeSequence) || wakeSequence < 0) {
      throw new RangeError("eligibility wake sequence must be a non-negative safe integer");
    }
    if (record.networkId !== this.#deployment.network) {
      throw new Error("eligibility job belongs to another network");
    }
    const script = policyScript(record, this.#deployment, observedPolicyScript);
    const inspected = inspectJobData(record.data, {
      manifest: this.#deployment.manifest,
      expectedGenesisHash: this.#deployment.genesisHash,
      policyScript: script,
    });
    if (
      inspected.status !== "ok" ||
      inspected.job.jobId !== parseHash32(record.jobId) ||
      inspected.job.sequence !== parseSequence(record.sequence) ||
      inspected.policy.kind !== record.policyKind
    ) {
      throw new Error("indexed live job does not match its committed data");
    }
    const result = evaluateExecutorEligibility(
      this.#registry,
      snapshot(record, tip, this.#deployment, observedPolicyScript),
    );
    if (result.eligibility.status === "eligible") {
      await this.#queues.enqueue(
        "build",
        "build-transaction",
        identity(record),
        Object.freeze({
          jobId: record.jobId,
          sequence: record.sequence,
          adapterId: result.adapterId,
          evaluatedAt: Object.freeze({
            blockHash: tip.hash,
            blockNumber: tip.number.toString(),
          }),
        } satisfies BuildQueuePayload),
      );
      return Object.freeze({
        status: "ready",
        jobId: record.jobId,
        sequence: record.sequence,
        adapterId: result.adapterId,
        observedTip: tip.number.toString(),
      });
    }
    if (result.eligibility.terminal) {
      return Object.freeze({
        status: "terminal",
        jobId: record.jobId,
        sequence: record.sequence,
        reason: result.eligibility.reason,
      });
    }
    const delayMs = nextEvaluationDelay(inspected.job.notBefore, tip.number);
    if (wakeSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("eligibility wake sequence is exhausted");
    }
    const nextWakeSequence = wakeSequence + 1;
    await this.#queues.enqueue(
      "evaluate",
      "evaluate-job",
      `${identity(record)}/wake-${nextWakeSequence}`,
      Object.freeze({
        jobId: record.jobId,
        sequence: record.sequence,
        wakeSequence: nextWakeSequence,
      }),
      { delay: delayMs },
    );
    return Object.freeze({
      status: "waiting",
      jobId: record.jobId,
      sequence: record.sequence,
      observedTip: tip.number.toString(),
      notBefore: inspected.job.notBefore.toString(),
      delayMs,
    });
  }
}
