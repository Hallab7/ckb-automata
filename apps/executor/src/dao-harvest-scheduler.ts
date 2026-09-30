import {
  compareEpochFractions,
  decodeAbsoluteEpochSince,
  parseEpoch,
  parseHash32,
  parseSequence,
  parseShannons,
  type Hash32,
  type IntegerInput,
} from "@ckb-automata/core";

import type { QueueEnqueuer } from "./queues.ts";

export const DAO_HARVEST_MAX_WAKE_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;
export const DAO_HARVEST_MIN_WAKE_DELAY_MS = 1_000;

export interface DaoHarvestScheduleRecord {
  readonly jobId: Hash32;
  readonly sequence: IntegerInput;
  readonly remainingRuns: IntegerInput;
  readonly remainingBudget: IntegerInput;
  readonly executorReward: IntegerInput;
  readonly prepareStartSince: IntegerInput;
  readonly prepareCutoffSince: IntegerInput;
  readonly claimMaturitySince: IntegerInput | null;
  readonly endEpochSince: IntegerInput;
  readonly canonical: boolean;
  readonly live: boolean;
  readonly approvedPrepareExecutor: boolean;
}

export type DaoHarvestScheduleDecision =
  | {
      readonly status: "ready";
      readonly operation: "prepare" | "roll";
      readonly jobId: Hash32;
      readonly sequence: string;
    }
  | {
      readonly status: "waiting";
      readonly operation: "prepare" | "roll";
      readonly jobId: Hash32;
      readonly sequence: string;
      readonly notBefore: string;
      readonly delayMs: number;
      readonly reason: "early" | "reorg_recovery";
    }
  | {
      readonly status: "rollover";
      readonly operation: "prepare";
      readonly jobId: Hash32;
      readonly sequence: string;
      readonly reason: "missed_prepare_window";
    }
  | {
      readonly status: "terminal";
      readonly jobId: Hash32;
      readonly sequence: string;
      readonly reason:
        | "spent"
        | "unauthorized_prepare_executor"
        | "insufficient_reward_budget"
        | "cycle_limit"
        | "end_epoch_reached"
        | "missing_claim_maturity";
    };

function epoch(value: IntegerInput) {
  return decodeAbsoluteEpochSince(value);
}

function wakeDelay(notBefore: ReturnType<typeof epoch>, tip: ReturnType<typeof epoch>): number {
  if (compareEpochFractions(tip, notBefore) >= 0) return DAO_HARVEST_MIN_WAKE_DELAY_MS;
  const wholeEpochs = notBefore.number - tip.number;
  const estimate = wholeEpochs <= 0n ? 60_000n : wholeEpochs * 4n * 60n * 60n * 1_000n;
  return Number(
    estimate > BigInt(DAO_HARVEST_MAX_WAKE_DELAY_MS)
      ? DAO_HARVEST_MAX_WAKE_DELAY_MS
      : estimate < BigInt(DAO_HARVEST_MIN_WAKE_DELAY_MS)
        ? DAO_HARVEST_MIN_WAKE_DELAY_MS
        : estimate,
  );
}

export function evaluateDaoHarvestSchedule(
  record: DaoHarvestScheduleRecord,
  tipEpochValue: IntegerInput,
): DaoHarvestScheduleDecision {
  const jobId = parseHash32(record.jobId);
  const sequence = parseSequence(record.sequence);
  const remainingRuns = BigInt(record.remainingRuns);
  const remainingBudget = parseShannons(record.remainingBudget);
  const reward = parseShannons(record.executorReward);
  const tip = parseEpoch(tipEpochValue);
  const operation = sequence % 2n === 0n ? "prepare" : "roll";
  if (!record.live)
    return Object.freeze({
      status: "terminal",
      jobId,
      sequence: sequence.toString(),
      reason: "spent",
    });
  if (remainingRuns <= 0n)
    return Object.freeze({
      status: "terminal",
      jobId,
      sequence: sequence.toString(),
      reason: "cycle_limit",
    });
  if (remainingBudget < reward)
    return Object.freeze({
      status: "terminal",
      jobId,
      sequence: sequence.toString(),
      reason: "insufficient_reward_budget",
    });
  const endSince = BigInt(record.endEpochSince);
  if (
    operation === "prepare" &&
    endSince !== 0n &&
    compareEpochFractions(tip, epoch(endSince)) >= 0
  ) {
    return Object.freeze({
      status: "terminal",
      jobId,
      sequence: sequence.toString(),
      reason: "end_epoch_reached",
    });
  }
  const notBeforeValue =
    operation === "prepare" ? record.prepareStartSince : record.claimMaturitySince;
  if (notBeforeValue === null) {
    return Object.freeze({
      status: "terminal",
      jobId,
      sequence: sequence.toString(),
      reason: "missing_claim_maturity",
    });
  }
  const notBefore = epoch(notBeforeValue);
  if (!record.canonical) {
    return Object.freeze({
      status: "waiting",
      operation,
      jobId,
      sequence: sequence.toString(),
      notBefore: BigInt(notBeforeValue).toString(),
      delayMs: DAO_HARVEST_MIN_WAKE_DELAY_MS,
      reason: "reorg_recovery",
    });
  }
  if (compareEpochFractions(tip, notBefore) < 0) {
    return Object.freeze({
      status: "waiting",
      operation,
      jobId,
      sequence: sequence.toString(),
      notBefore: BigInt(notBeforeValue).toString(),
      delayMs: wakeDelay(notBefore, tip),
      reason: "early",
    });
  }
  if (operation === "prepare") {
    if (compareEpochFractions(tip, epoch(record.prepareCutoffSince)) >= 0) {
      return Object.freeze({
        status: "rollover",
        operation: "prepare",
        jobId,
        sequence: sequence.toString(),
        reason: "missed_prepare_window",
      });
    }
    if (!record.approvedPrepareExecutor) {
      return Object.freeze({
        status: "terminal",
        jobId,
        sequence: sequence.toString(),
        reason: "unauthorized_prepare_executor",
      });
    }
  }
  return Object.freeze({ status: "ready", operation, jobId, sequence: sequence.toString() });
}

export function assertDaoHarvestSubmissionWindow(
  record: DaoHarvestScheduleRecord,
  tipEpochValue: IntegerInput,
): "prepare" | "roll" {
  const decision = evaluateDaoHarvestSchedule(record, tipEpochValue);
  if (decision.status !== "ready") {
    throw Object.assign(new Error(`DAO harvest submission is not allowed (${decision.reason})`), {
      code: "EXECUTOR_NOT_YET_ELIGIBLE",
    });
  }
  return decision.operation;
}

export type DaoHarvestAttemptObservation =
  | { readonly kind: "pending" }
  | { readonly kind: "committed"; readonly txHash: Hash32; readonly canonical: boolean }
  | { readonly kind: "spent"; readonly spendingTxHash: Hash32 }
  | { readonly kind: "dropped"; readonly inputRestored: boolean };

export function reconcileDaoHarvestAttempt(
  submittedTxHash: Hash32,
  observation: DaoHarvestAttemptObservation,
): "pending" | "confirmed" | "reorged" | "conflicted" | "retry" | "recovery_required" {
  const submitted = parseHash32(submittedTxHash);
  switch (observation.kind) {
    case "pending":
      return "pending";
    case "committed":
      return observation.txHash === submitted
        ? observation.canonical
          ? "confirmed"
          : "reorged"
        : "conflicted";
    case "spent":
      return observation.spendingTxHash === submitted ? "pending" : "conflicted";
    case "dropped":
      return observation.inputRestored ? "retry" : "recovery_required";
  }
}

export class DaoHarvestScheduler {
  readonly #queues: Pick<QueueEnqueuer, "enqueue">;

  constructor(queues: Pick<QueueEnqueuer, "enqueue">) {
    this.#queues = queues;
  }

  async schedule(
    record: DaoHarvestScheduleRecord,
    tipEpochValue: IntegerInput,
    wakeSequence: number,
  ): Promise<DaoHarvestScheduleDecision> {
    if (!Number.isSafeInteger(wakeSequence) || wakeSequence < 0) {
      throw new RangeError("wakeSequence must be a non-negative safe integer");
    }
    const decision = evaluateDaoHarvestSchedule(record, tipEpochValue);
    const identity = `${decision.jobId}/${decision.sequence}`;
    if (decision.status === "ready") {
      await this.#queues.enqueue("build", `dao-harvest-${decision.operation}`, identity, {
        jobId: decision.jobId,
        sequence: decision.sequence,
        operation: decision.operation,
      });
    } else if (decision.status === "waiting") {
      await this.#queues.enqueue(
        "evaluate",
        "dao-harvest-evaluate",
        `${identity}/wake-${wakeSequence + 1}`,
        { jobId: decision.jobId, sequence: decision.sequence, wakeSequence: wakeSequence + 1 },
        { delay: decision.delayMs },
      );
    }
    return decision;
  }
}
