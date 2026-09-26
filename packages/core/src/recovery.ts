import { JobDataV1 } from "@ckb-automata/molecule";
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
  sameCellDepValue,
  toRpcHex,
  type Hash32,
  type OutPoint,
  type Shannons,
} from "./chain-values.ts";
import type { UnsignedDeadlineTransaction as UnsignedTransaction } from "./deadline-creation.ts";
import type { RegisteredDeployment } from "./deployment-registry.ts";
import {
  inspectJobData,
  type CellDepIdentity,
  type JobInspectionResult,
  type ScriptIdentity,
} from "./job-inspection.ts";

type Hex = `0x${string}`;

export const RECOVERY_OPERATION = "0x02" as const;
export const RECOVERY_REASONS = [
  "unsupported_metadata",
  "invalid_application_state",
  "terminal_operational_failure",
] as const;

export type RecoveryReason = (typeof RECOVERY_REASONS)[number];
export type RecoveryErrorCode =
  | "STALE_OUTPOINT"
  | "OWNER_MISMATCH"
  | "INVALID_JOB_CELL"
  | "UNSUPPORTED_POLICY"
  | "REASON_MISMATCH";

export class RecoveryBuildError extends Error {
  override readonly name = "RecoveryBuildError";
  readonly code: RecoveryErrorCode;

  constructor(code: RecoveryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RecoveryInput {
  readonly deployment: RegisteredDeployment;
  readonly resolver: LiveCellResolver;
  readonly jobOutPoint: OutPoint;
  readonly ownerLock: ScriptIdentity;
  readonly reason: RecoveryReason;
}

export interface RecoveryOutputPreview {
  readonly jobOutPoint: OutPoint;
  readonly jobId: Hash32;
  readonly reason: RecoveryReason;
  readonly refund: {
    readonly capacity: Shannons;
    readonly lock: ScriptIdentity;
    readonly type: null;
    readonly data: "0x";
  };
  readonly paysExecutorReward: false;
  readonly createsSuccessor: false;
}

export interface RecoveryBuild {
  readonly transaction: UnsignedTransaction;
  readonly preview: RecoveryOutputPreview;
  readonly ownerLockHash: Hash32;
  readonly inspection: JobInspectionResult;
  readonly completion: {
    readonly requiredInputCount: 2;
    readonly requiredOutputCount: 1;
    readonly requiredInputType: typeof RECOVERY_OPERATION;
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

function invalidJob(message: string): never {
  throw new RecoveryBuildError("INVALID_JOB_CELL", message);
}

function policyDependency(
  deployment: RegisteredDeployment,
  policyScript: ScriptIdentity | null,
): CellDepIdentity | null {
  if (!policyScript) return null;
  for (const name of ["recurring-policy", "deadline-policy"] as const) {
    const registered = deployment.contracts[name];
    if (
      policyScript.codeHash === registered.script.codeHash &&
      policyScript.hashType === registered.script.hashType &&
      ((name === "recurring-policy" && policyScript.args === "0x") ||
        (name === "deadline-policy" && /^0x[0-9a-f]{64}$/.test(policyScript.args)))
    ) {
      return registered.cellDep;
    }
  }
  throw new RecoveryBuildError(
    "UNSUPPORTED_POLICY",
    "the live cell uses a policy script whose recovery behavior is not registered",
  );
}

function reasonMatches(
  reason: RecoveryReason,
  inspection: JobInspectionResult,
  hasPolicyScript: boolean,
): boolean {
  if (reason === "terminal_operational_failure") {
    return inspection.status === "ok" && hasPolicyScript;
  }
  if (reason === "invalid_application_state") return inspection.status === "invalid_job";
  return (
    !hasPolicyScript ||
    inspection.status === "unsupported_version" ||
    inspection.status === "policy_mismatch"
  );
}

function witnessInputType(witness: Hex): Hex | null {
  const bytes = hexToBytes(witness);
  if (bytes.length < 16) throw new Error("recovery witness is not a Molecule WitnessArgs table");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0, true);
  const inputOffset = view.getUint32(8, true);
  const outputOffset = view.getUint32(12, true);
  if (total !== bytes.length || inputOffset > outputOffset || outputOffset > total) {
    throw new Error("recovery witness has invalid Molecule offsets");
  }
  const field = bytes.slice(inputOffset, outputOffset);
  if (field.length === 0) return null;
  if (
    field.length < 4 ||
    new DataView(field.buffer, field.byteOffset, field.byteLength).getUint32(0, true) !==
      field.length - 4
  ) {
    throw new Error("recovery witness has an invalid input_type field");
  }
  return bytesToHex(field.slice(4)) as Hex;
}

export async function buildRecovery(input: RecoveryInput): Promise<RecoveryBuild> {
  if (!RECOVERY_REASONS.includes(input.reason)) {
    throw new RecoveryBuildError("REASON_MISMATCH", "select a supported recovery reason");
  }
  const jobOutPoint = parseOutPoint(input.jobOutPoint);
  const live = await input.resolver.resolve(jobOutPoint);
  if (!live) {
    throw new RecoveryBuildError(
      "STALE_OUTPOINT",
      `the Job Cell at ${jobOutPoint.txHash}:${jobOutPoint.index} is no longer live; refresh before recovery`,
    );
  }
  const resolvedOutPoint = parseOutPoint(live.outPoint);
  if (
    resolvedOutPoint.txHash !== jobOutPoint.txHash ||
    resolvedOutPoint.index !== jobOutPoint.index
  ) {
    invalidJob("the live-cell resolver returned a different outpoint");
  }
  const expectedJobLock = script(input.deployment.contracts["job-lock"], "0x");
  if (stable(live.output.lock) !== stable(expectedJobLock)) {
    invalidJob("the resolved cell is not locked by the registered Job Lock");
  }
  let decoded: ReturnType<typeof JobDataV1.unpack>;
  try {
    decoded = JobDataV1.unpack(typeof live.data === "string" ? hexToBytes(live.data) : live.data);
  } catch {
    invalidJob("recovery requires structurally decodable JobDataV1 bytes");
  }
  const jobId = hash32FromBytes(Uint8Array.from(decoded.job_id));
  const committedOwner = hash32FromBytes(Uint8Array.from(decoded.cancel_lock_hash));
  const ownerLockHash = parseHash32(scriptToHash(input.ownerLock));
  if (ownerLockHash !== committedOwner) {
    throw new RecoveryBuildError(
      "OWNER_MISMATCH",
      `the selected owner lock hashes to ${ownerLockHash}, but the Job Cell requires ${committedOwner}`,
    );
  }
  const policyDep = policyDependency(input.deployment, live.output.type);
  const inspection = inspectJobData(live.data, {
    manifest: input.deployment.manifest,
    expectedGenesisHash: input.deployment.genesisHash,
    ...(live.output.type ? { policyScript: live.output.type } : {}),
  });
  if (inspection.status === "malformed" || inspection.status === "manifest_error") {
    invalidJob(`the resolved Job Cell failed inspection (${inspection.status})`);
  }
  if (!reasonMatches(input.reason, inspection, live.output.type !== null)) {
    throw new RecoveryBuildError(
      "REASON_MISMATCH",
      `recovery reason ${input.reason} does not match inspection result ${inspection.status}`,
    );
  }
  const refundCapacity = parseShannons(live.output.capacity);
  const cellDeps = [
    input.deployment.manifest.secp256k1Blake160.cellDep,
    input.deployment.contracts["job-lock"].cellDep,
    ...(policyDep ? [policyDep] : []),
  ];
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze(cellDeps),
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
      serializeWitnessArgs({ lock: "", inputType: RECOVERY_OPERATION, outputType: "" }) as Hex,
    ]),
  });
  const preview: RecoveryOutputPreview = Object.freeze({
    jobOutPoint,
    jobId,
    reason: input.reason,
    refund: Object.freeze({
      capacity: refundCapacity,
      lock: Object.freeze({ ...input.ownerLock }),
      type: null,
      data: "0x",
    }),
    paysExecutorReward: false,
    createsSuccessor: false,
  });
  return Object.freeze({
    transaction,
    preview,
    ownerLockHash,
    inspection,
    completion: Object.freeze({
      requiredInputCount: 2,
      requiredOutputCount: 1,
      requiredInputType: RECOVERY_OPERATION,
    }),
  });
}

export function assertRecoveryCompletion(
  build: RecoveryBuild,
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
    throw new Error("wallet completion changed the exact recovery refund");
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
    throw new Error("wallet completion changed the recovery operation in witness 0");
  }
}
