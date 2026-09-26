import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  parseHash32,
  parseOutPoint,
  parseShannons,
  sameCellDepValue,
  toRpcHex,
  type Hash32,
  type IntegerInput,
  type OutPoint,
  type Shannons,
} from "./chain-values.ts";
import type { UnsignedDeadlineTransaction as UnsignedTransaction } from "./deadline-creation.ts";
import type { RegisteredDeployment } from "./deployment-registry.ts";
import { inspectJobData, type ScriptIdentity, type PolicyMetadata } from "./job-inspection.ts";

type Hex = `0x${string}`;

export const CANCELLATION_OPERATION = "0x01" as const;

export type CancellationErrorCode =
  "STALE_OUTPOINT" | "OWNER_MISMATCH" | "INVALID_JOB_CELL" | "UNSUPPORTED_POLICY";

export class CancellationBuildError extends Error {
  override readonly name = "CancellationBuildError";
  readonly code: CancellationErrorCode;

  constructor(code: CancellationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ResolvedLiveCell {
  readonly outPoint: OutPoint;
  readonly output: {
    readonly capacity: IntegerInput;
    readonly lock: ScriptIdentity;
    readonly type: ScriptIdentity | null;
  };
  readonly data: Uint8Array | Hex;
}

export interface LiveCellResolver {
  resolve(outPoint: OutPoint): Promise<ResolvedLiveCell | null>;
}

export interface CancellationInput {
  readonly deployment: RegisteredDeployment;
  readonly resolver: LiveCellResolver;
  readonly jobOutPoint: OutPoint;
  readonly ownerLock: ScriptIdentity;
}

export interface CancellationBuild {
  readonly transaction: UnsignedTransaction;
  readonly jobOutPoint: OutPoint;
  readonly jobId: Hash32;
  readonly ownerLockHash: Hash32;
  readonly refundCapacity: Shannons;
  readonly policy: Extract<PolicyMetadata, { readonly kind: "recurring" | "deadline" }>;
  readonly completion: {
    readonly requiredInputCount: 2;
    readonly requiredOutputCount: 1;
    readonly requiredInputType: typeof CANCELLATION_OPERATION;
  };
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function script(
  contract: { readonly script: Omit<ScriptIdentity, "args"> },
  args: Hex,
): ScriptIdentity {
  return Object.freeze({ ...contract.script, args });
}

function sameOutPoint(left: OutPoint, right: OutPoint): boolean {
  return left.txHash === right.txHash && left.index === right.index;
}

function invalidJob(message: string): never {
  throw new CancellationBuildError("INVALID_JOB_CELL", message);
}

function supportedPolicy(
  deployment: RegisteredDeployment,
  policyScript: ScriptIdentity,
): "recurring-policy" | "deadline-policy" {
  const recurring = deployment.contracts["recurring-policy"].script;
  if (
    policyScript.codeHash === recurring.codeHash &&
    policyScript.hashType === recurring.hashType &&
    policyScript.args === "0x"
  ) {
    return "recurring-policy";
  }
  const deadline = deployment.contracts["deadline-policy"].script;
  if (
    policyScript.codeHash === deadline.codeHash &&
    policyScript.hashType === deadline.hashType &&
    /^0x[0-9a-f]{64}$/.test(policyScript.args)
  ) {
    return "deadline-policy";
  }
  throw new CancellationBuildError(
    "UNSUPPORTED_POLICY",
    "the live Job Cell does not use a cancellation-capable policy from this deployment",
  );
}

function witnessInputType(witness: Hex): Hex | null {
  const bytes = hexToBytes(witness);
  if (bytes.length < 16)
    throw new Error("cancellation witness is not a Molecule WitnessArgs table");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0, true);
  const inputOffset = view.getUint32(8, true);
  const outputOffset = view.getUint32(12, true);
  if (total !== bytes.length || inputOffset > outputOffset || outputOffset > total) {
    throw new Error("cancellation witness has invalid Molecule offsets");
  }
  const field = bytes.slice(inputOffset, outputOffset);
  if (field.length === 0) return null;
  if (
    field.length < 4 ||
    new DataView(field.buffer, field.byteOffset, field.byteLength).getUint32(0, true) !==
      field.length - 4
  ) {
    throw new Error("cancellation witness has an invalid input_type field");
  }
  return bytesToHex(field.slice(4)) as Hex;
}

export async function buildCancellation(input: CancellationInput): Promise<CancellationBuild> {
  const jobOutPoint = parseOutPoint(input.jobOutPoint);
  const live = await input.resolver.resolve(jobOutPoint);
  if (!live) {
    throw new CancellationBuildError(
      "STALE_OUTPOINT",
      `the Job Cell at ${jobOutPoint.txHash}:${jobOutPoint.index} is no longer live; refresh before cancelling`,
    );
  }
  const resolvedOutPoint = parseOutPoint(live.outPoint);
  if (!sameOutPoint(jobOutPoint, resolvedOutPoint)) {
    invalidJob("the live-cell resolver returned a different outpoint");
  }
  const expectedJobLock = script(input.deployment.contracts["job-lock"], "0x");
  if (stable(live.output.lock) !== stable(expectedJobLock)) {
    invalidJob("the resolved cell is not locked by the registered Job Lock");
  }
  if (!live.output.type) {
    invalidJob("the resolved Job Cell is missing its committed policy type script");
  }
  const policyContract = supportedPolicy(input.deployment, live.output.type);
  const inspection = inspectJobData(live.data, {
    manifest: input.deployment.manifest,
    expectedGenesisHash: input.deployment.genesisHash,
    policyScript: live.output.type,
  });
  if (inspection.status !== "ok") {
    invalidJob(`the resolved Job Cell failed inspection (${inspection.status})`);
  }
  if (inspection.policy.kind !== "recurring" && inspection.policy.kind !== "deadline") {
    throw new CancellationBuildError(
      "UNSUPPORTED_POLICY",
      "the live Job Cell policy cannot be cancelled by this SDK",
    );
  }
  const ownerLockHash = parseHash32(scriptToHash(input.ownerLock));
  if (ownerLockHash !== inspection.job.cancelLockHash) {
    throw new CancellationBuildError(
      "OWNER_MISMATCH",
      `the selected owner lock hashes to ${ownerLockHash}, but the Job Cell requires ${inspection.job.cancelLockHash}`,
    );
  }
  const refundCapacity = parseShannons(live.output.capacity);
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([
      input.deployment.manifest.secp256k1Blake160.cellDep,
      input.deployment.contracts["job-lock"].cellDep,
      input.deployment.contracts[policyContract].cellDep,
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
    outputs: Object.freeze([
      Object.freeze({
        capacity: toRpcHex(refundCapacity),
        lock: Object.freeze({ ...input.ownerLock }),
        type: null,
      }),
    ]),
    outputsData: Object.freeze(["0x" as const]),
    witnesses: Object.freeze([
      serializeWitnessArgs({ lock: "", inputType: CANCELLATION_OPERATION, outputType: "" }) as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    jobOutPoint,
    jobId: inspection.job.jobId,
    ownerLockHash,
    refundCapacity,
    policy: inspection.policy,
    completion: Object.freeze({
      requiredInputCount: 2,
      requiredOutputCount: 1,
      requiredInputType: CANCELLATION_OPERATION,
    }),
  });
}

export function assertCancellationCompletion(
  build: CancellationBuild,
  completed: UnsignedTransaction,
): void {
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
    completed.outputsData[0] !== "0x"
  ) {
    throw new Error("wallet completion changed the exact owner refund");
  }
  if (completed.outputs.length !== completed.outputsData.length) {
    throw new Error("completed outputs and data lengths differ");
  }
  for (const requiredDep of build.transaction.cellDeps) {
    if (!completed.cellDeps.some((candidate) => sameCellDepValue(candidate, requiredDep))) {
      throw new Error("wallet completion removed a required cell dependency");
    }
  }
  const firstWitness = completed.witnesses[0];
  if (!firstWitness || witnessInputType(firstWitness) !== build.completion.requiredInputType) {
    throw new Error("wallet completion changed the cancellation operation in witness 0");
  }
}
