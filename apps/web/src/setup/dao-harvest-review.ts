import type { ApiDaoHarvestBuild } from "@ckb-automata/api-client";
import type { UnsignedDeadlineTransaction } from "@ckb-automata/core";

const HASH = /^0x[0-9a-f]{64}$/;

export interface ExpectedDaoHarvestIntent {
  readonly ownerLockHash: string;
  readonly payoutLockHash: string;
  readonly principal: bigint;
  readonly totalCycles: number;
}

function decimal(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`The transaction has an invalid ${name}.`);
  }
  return BigInt(value);
}

function sameRequiredOutput(
  expected: UnsignedDeadlineTransaction["outputs"][number],
  actual: UnsignedDeadlineTransaction["outputs"][number] | undefined,
): boolean {
  return actual !== undefined && JSON.stringify(expected) === JSON.stringify(actual);
}

export function verifyDaoHarvestSetupBuild(
  build: ApiDaoHarvestBuild,
  expected: ExpectedDaoHarvestIntent,
): void {
  if (build.operation !== "setup") throw new Error("The API returned the wrong owner action.");
  if (!HASH.test(build.policyCriticalHash)) throw new Error("The policy proof is missing.");
  if (build.jobId !== undefined && !HASH.test(build.jobId)) {
    throw new Error("The automation identifier is invalid.");
  }
  const intent = build.intent;
  if (
    intent["ownerLockHash"] !== expected.ownerLockHash ||
    intent["payoutLockHash"] !== expected.payoutLockHash ||
    decimal(intent["principal"], "original amount") !== expected.principal ||
    intent["totalCycles"] !== expected.totalCycles
  ) {
    throw new Error("The transaction does not match the displayed harvest plan.");
  }
  if (build.transaction.inputs.length !== 0) {
    throw new Error("The setup builder unexpectedly selected wallet inputs.");
  }
  if (build.transaction.outputs.length !== 2 || build.transaction.outputsData.length !== 2) {
    throw new Error("The setup transaction has an unexpected output layout.");
  }
  const vault = build.transaction.outputs[0];
  const job = build.transaction.outputs[1];
  if (
    vault === undefined ||
    job === undefined ||
    BigInt(vault.capacity) !== expected.principal ||
    vault.type === null ||
    job.type === null ||
    build.transaction.outputsData[0] !== "0x0000000000000000"
  ) {
    throw new Error("The transaction does not preserve the reviewed DAO deposit.");
  }
  if (build.signingEntries.length === 0) throw new Error("The owner approval request is missing.");
}

export function verifyCompletedDaoHarvestTransaction(
  reviewed: UnsignedDeadlineTransaction,
  completed: UnsignedDeadlineTransaction,
): void {
  if (
    !sameRequiredOutput(reviewed.outputs[0]!, completed.outputs[0]) ||
    !sameRequiredOutput(reviewed.outputs[1]!, completed.outputs[1]) ||
    reviewed.outputsData[0] !== completed.outputsData[0] ||
    reviewed.outputsData[1] !== completed.outputsData[1] ||
    JSON.stringify(reviewed.cellDeps) !== JSON.stringify(completed.cellDeps) ||
    JSON.stringify(reviewed.headerDeps) !== JSON.stringify(completed.headerDeps)
  ) {
    throw new Error("Wallet funding changed the reviewed harvest policy.");
  }
}

export function verifyCompletedDaoHarvestOwnerAction(
  reviewed: UnsignedDeadlineTransaction,
  completed: UnsignedDeadlineTransaction,
): void {
  if (
    reviewed.outputs.some(
      (output, index) => !sameRequiredOutput(output, completed.outputs[index]),
    ) ||
    reviewed.outputsData.some((data, index) => data !== completed.outputsData[index]) ||
    JSON.stringify(reviewed.cellDeps) !== JSON.stringify(completed.cellDeps) ||
    JSON.stringify(reviewed.headerDeps) !== JSON.stringify(completed.headerDeps) ||
    reviewed.witnesses.some((witness, index) => witness !== completed.witnesses[index])
  ) {
    throw new Error("Wallet funding changed the reviewed owner action.");
  }
}
