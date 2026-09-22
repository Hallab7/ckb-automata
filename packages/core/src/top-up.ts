import { JobDataV1, type JobDataV1Value } from "@ckb-automata/molecule";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import type { LiveCellResolver } from "./cancellation.ts";
import {
  hash32FromBytes,
  parseHash32,
  parseOutPoint,
  parseShannons,
  toRpcHex,
  type Hash32,
  type IntegerInput,
  type OutPoint,
  type Shannons,
} from "./chain-values.ts";
import { CONTRACT_CAPACITY } from "./contract-costs.ts";
import type { UnsignedDeadlineTransaction as UnsignedTransaction } from "./deadline-creation.ts";
import type { RegisteredDeployment } from "./deployment-registry.ts";
import { inspectJobData, type CellDepIdentity, type ScriptIdentity } from "./job-inspection.ts";

type Hex = `0x${string}`;

export const TOP_UP_OPERATION = "0x0300000000" as const;

export type TopUpErrorCode =
  | "STALE_OUTPOINT"
  | "OWNER_MISMATCH"
  | "INVALID_JOB_CELL"
  | "UNSUPPORTED_POLICY"
  | "INVALID_INCREASE";

export class TopUpBuildError extends Error {
  override readonly name = "TopUpBuildError";
  readonly code: TopUpErrorCode;

  constructor(code: TopUpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface JobCellSnapshot {
  readonly capacity: IntegerInput;
  readonly lock: ScriptIdentity;
  readonly type: ScriptIdentity | null;
  readonly data: Uint8Array | Hex;
}

export interface TopUpInput {
  readonly deployment: RegisteredDeployment;
  readonly resolver: LiveCellResolver;
  readonly jobOutPoint: OutPoint;
  readonly ownerLock: ScriptIdentity;
  readonly rewardIncrease: IntegerInput;
  readonly budgetIncrease: IntegerInput;
  readonly capacityIncrease: IntegerInput;
}

export interface TopUpDiff {
  readonly classification: "top_up" | "edit_or_migration";
  readonly immutableChanges: readonly string[];
  readonly funding: {
    readonly reward: {
      readonly before: Shannons;
      readonly after: Shannons;
      readonly delta: bigint;
    };
    readonly remainingBudget: {
      readonly before: Shannons;
      readonly after: Shannons;
      readonly delta: bigint;
    };
    readonly capacity: {
      readonly before: Shannons;
      readonly after: Shannons;
      readonly delta: bigint;
    };
  };
}

export interface TopUpBuild {
  readonly transaction: UnsignedTransaction;
  readonly jobOutPoint: OutPoint;
  readonly jobId: Hash32;
  readonly ownerLockHash: Hash32;
  readonly diff: TopUpDiff;
  readonly completion: {
    readonly requiredInputCount: 2;
    readonly requiredOutputCount: 1;
    readonly successorOutputIndex: 0;
    readonly requiredInputType: typeof TOP_UP_OPERATION;
  };
}

const IMMUTABLE_FIELDS = [
  "version",
  "flags",
  "job_id",
  "sequence",
  "state",
  "trigger_kind",
  "trigger_params_hash",
  "policy_script_hash",
  "payload_hash",
  "not_before",
  "not_after",
  "remaining_runs",
  "cancel_lock_hash",
] as const;

function stable(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function decode(data: Uint8Array | Hex): JobDataV1Value {
  return JobDataV1.unpack(typeof data === "string" ? hexToBytes(data) : data);
}

function delta(after: Shannons, before: Shannons): bigint {
  return BigInt(after) - BigInt(before);
}

function policyDependency(
  deployment: RegisteredDeployment,
  policyScript: ScriptIdentity | null,
): {
  readonly contract: "recurring-policy" | "deadline-policy";
  readonly cellDep: CellDepIdentity;
} {
  if (policyScript) {
    for (const name of ["recurring-policy", "deadline-policy"] as const) {
      const registered = deployment.contracts[name];
      if (
        policyScript.codeHash === registered.script.codeHash &&
        policyScript.hashType === registered.script.hashType &&
        ((name === "recurring-policy" && policyScript.args === "0x") ||
          (name === "deadline-policy" && /^0x[0-9a-f]{64}$/.test(policyScript.args)))
      ) {
        return Object.freeze({ contract: name, cellDep: registered.cellDep });
      }
    }
  }
  throw new TopUpBuildError(
    "UNSUPPORTED_POLICY",
    "the live Job Cell does not use a top-up-capable policy from this deployment",
  );
}

function witnessInputType(witness: Hex): Hex | null {
  const bytes = hexToBytes(witness);
  if (bytes.length < 16) throw new Error("top-up witness is not a Molecule WitnessArgs table");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0, true);
  const inputOffset = view.getUint32(8, true);
  const outputOffset = view.getUint32(12, true);
  if (total !== bytes.length || inputOffset > outputOffset || outputOffset > total) {
    throw new Error("top-up witness has invalid Molecule offsets");
  }
  const field = bytes.slice(inputOffset, outputOffset);
  if (field.length === 0) return null;
  if (
    field.length < 4 ||
    new DataView(field.buffer, field.byteOffset, field.byteLength).getUint32(0, true) !==
      field.length - 4
  ) {
    throw new Error("top-up witness has an invalid input_type field");
  }
  return bytesToHex(field.slice(4)) as Hex;
}

export function inspectTopUpDiff(before: JobCellSnapshot, after: JobCellSnapshot): TopUpDiff {
  const previous = decode(before.data);
  const successor = decode(after.data);
  const immutableChanges: string[] = IMMUTABLE_FIELDS.filter(
    (field) => stable(previous[field]) !== stable(successor[field]),
  );
  if (stable(before.lock) !== stable(after.lock)) immutableChanges.push("lock_script");
  if (stable(before.type) !== stable(after.type)) immutableChanges.push("type_script");
  const beforeReward = parseShannons(previous.reward.toString());
  const afterReward = parseShannons(successor.reward.toString());
  const beforeBudget = parseShannons(previous.remaining_budget.toString());
  const afterBudget = parseShannons(successor.remaining_budget.toString());
  const beforeCapacity = parseShannons(before.capacity);
  const afterCapacity = parseShannons(after.capacity);
  const rewardDelta = delta(afterReward, beforeReward);
  const budgetDelta = delta(afterBudget, beforeBudget);
  const capacityDelta = delta(afterCapacity, beforeCapacity);
  const funded =
    rewardDelta >= 0n &&
    budgetDelta >= 0n &&
    capacityDelta >= 0n &&
    (rewardDelta > 0n || budgetDelta > 0n) &&
    afterReward <= afterBudget &&
    afterBudget <= afterCapacity - CONTRACT_CAPACITY.jobCellV1;
  return Object.freeze({
    classification: immutableChanges.length === 0 && funded ? "top_up" : "edit_or_migration",
    immutableChanges: Object.freeze(immutableChanges),
    funding: Object.freeze({
      reward: Object.freeze({ before: beforeReward, after: afterReward, delta: rewardDelta }),
      remainingBudget: Object.freeze({
        before: beforeBudget,
        after: afterBudget,
        delta: budgetDelta,
      }),
      capacity: Object.freeze({
        before: beforeCapacity,
        after: afterCapacity,
        delta: capacityDelta,
      }),
    }),
  });
}

export async function buildTopUp(input: TopUpInput): Promise<TopUpBuild> {
  const jobOutPoint = parseOutPoint(input.jobOutPoint);
  const live = await input.resolver.resolve(jobOutPoint);
  if (!live) {
    throw new TopUpBuildError(
      "STALE_OUTPOINT",
      `the Job Cell at ${jobOutPoint.txHash}:${jobOutPoint.index} is no longer live; refresh before topping up`,
    );
  }
  const resolvedOutPoint = parseOutPoint(live.outPoint);
  if (
    resolvedOutPoint.txHash !== jobOutPoint.txHash ||
    resolvedOutPoint.index !== jobOutPoint.index
  ) {
    throw new TopUpBuildError("INVALID_JOB_CELL", "the resolver returned a different outpoint");
  }
  const jobLock = { ...input.deployment.contracts["job-lock"].script, args: "0x" } as const;
  if (stable(live.output.lock) !== stable(jobLock)) {
    throw new TopUpBuildError(
      "INVALID_JOB_CELL",
      "the resolved cell is not locked by the registered Job Lock",
    );
  }
  const policy = policyDependency(input.deployment, live.output.type);
  const inspection = inspectJobData(live.data, {
    manifest: input.deployment.manifest,
    expectedGenesisHash: input.deployment.genesisHash,
    ...(live.output.type ? { policyScript: live.output.type } : {}),
  });
  if (inspection.status !== "ok") {
    throw new TopUpBuildError(
      "INVALID_JOB_CELL",
      `the resolved Job Cell failed inspection (${inspection.status})`,
    );
  }
  const ownerLockHash = parseHash32(scriptToHash(input.ownerLock));
  if (ownerLockHash !== inspection.job.cancelLockHash) {
    throw new TopUpBuildError(
      "OWNER_MISMATCH",
      `the selected owner lock hashes to ${ownerLockHash}, but the Job Cell requires ${inspection.job.cancelLockHash}`,
    );
  }
  const rewardIncrease = parseShannons(input.rewardIncrease);
  const budgetIncrease = parseShannons(input.budgetIncrease);
  const capacityIncrease = parseShannons(input.capacityIncrease);
  if (policy.contract === "recurring-policy" && rewardIncrease > 0n) {
    throw new TopUpBuildError(
      "INVALID_INCREASE",
      "recurring reward is payload-committed; recurring top-up may increase budget only",
    );
  }
  if (rewardIncrease === 0n && budgetIncrease === 0n) {
    throw new TopUpBuildError(
      "INVALID_INCREASE",
      "top-up must increase reward, remaining budget, or both",
    );
  }
  const previous = decode(live.data);
  const nextReward = parseShannons(BigInt(previous.reward.toString()) + rewardIncrease);
  const nextBudget = parseShannons(BigInt(previous.remaining_budget.toString()) + budgetIncrease);
  const nextCapacity = parseShannons(parseShannons(live.output.capacity) + capacityIncrease);
  if (nextReward > nextBudget) {
    throw new TopUpBuildError(
      "INVALID_INCREASE",
      "the topped-up reward must not exceed remaining budget",
    );
  }
  if (nextBudget > nextCapacity - CONTRACT_CAPACITY.jobCellV1) {
    throw new TopUpBuildError(
      "INVALID_INCREASE",
      "capacity increase does not fund the topped-up remaining budget",
    );
  }
  const successorData = bytesToHex(
    JobDataV1.pack({
      ...previous,
      reward: nextReward.toString(),
      remaining_budget: nextBudget.toString(),
    }),
  ) as Hex;
  const successor = Object.freeze({
    capacity: toRpcHex(nextCapacity),
    lock: jobLock,
    type: live.output.type,
  });
  const before: JobCellSnapshot = { ...live.output, data: live.data };
  const after: JobCellSnapshot = { ...successor, data: successorData };
  const diff = inspectTopUpDiff(before, after);
  if (diff.classification !== "top_up") {
    throw new TopUpBuildError("INVALID_INCREASE", "requested changes are not a canonical top-up");
  }
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([
      input.deployment.manifest.secp256k1Blake160.cellDep,
      input.deployment.contracts["job-lock"].cellDep,
      policy.cellDep,
    ]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([
      Object.freeze({
        since: "0x0" as const,
        previousOutput: Object.freeze({
          txHash: jobOutPoint.txHash,
          index: toRpcHex(jobOutPoint.index),
        }),
      }),
    ]),
    outputs: Object.freeze([successor]),
    outputsData: Object.freeze([successorData]),
    witnesses: Object.freeze([
      serializeWitnessArgs({ lock: "", inputType: TOP_UP_OPERATION, outputType: "" }) as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    jobOutPoint,
    jobId: hash32FromBytes(Uint8Array.from(previous.job_id)),
    ownerLockHash,
    diff,
    completion: Object.freeze({
      requiredInputCount: 2,
      requiredOutputCount: 1,
      successorOutputIndex: 0,
      requiredInputType: TOP_UP_OPERATION,
    }),
  });
}

export function assertTopUpCompletion(build: TopUpBuild, completed: UnsignedTransaction): void {
  if (
    completed.version !== build.transaction.version ||
    stable(completed.headerDeps) !== stable(build.transaction.headerDeps)
  ) {
    throw new Error("wallet completion changed transaction metadata");
  }
  if (completed.inputs.length < build.completion.requiredInputCount) {
    throw new Error("wallet completion must append an owner-authentication input");
  }
  if (stable(completed.inputs[0]) !== stable(build.transaction.inputs[0])) {
    throw new Error("wallet completion changed the Job Cell input");
  }
  if (
    stable(completed.outputs[0]) !== stable(build.transaction.outputs[0]) ||
    completed.outputsData[0] !== build.transaction.outputsData[0]
  ) {
    throw new Error("wallet completion changed the exact top-up successor");
  }
  if (completed.outputs.length !== completed.outputsData.length) {
    throw new Error("completed outputs and data lengths differ");
  }
  for (const requiredDep of build.transaction.cellDeps) {
    if (!completed.cellDeps.some((candidate) => stable(candidate) === stable(requiredDep))) {
      throw new Error("wallet completion removed a required cell dependency");
    }
  }
  const firstWitness = completed.witnesses[0];
  if (!firstWitness || witnessInputType(firstWitness) !== build.completion.requiredInputType) {
    throw new Error("wallet completion changed the top-up operation in witness 0");
  }
}
