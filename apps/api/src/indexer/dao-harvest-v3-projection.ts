import type { ClientBlock } from "@ckb-ccc/shell";
import { bytesToHex, hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import {
  DAO_HARVEST_V3_ABSENT_INDEX,
  assertDaoHarvestV3WitnessLayout,
  deriveDaoHarvestV3PrepareCreditHash,
  hash32FromBytes,
  parseHash32,
  parseOutputIndex,
  scriptIdentityHash,
  type DaoHarvestV3Operation,
  type Hash32,
  type OutPoint,
  type ScriptIdentity,
  type Shannons,
} from "@ckb-automata/core";
import {
  DaoHarvestEnvelopeV3,
  DaoHarvestPayloadV3,
  DaoHarvestPrepareCreditV3,
  DaoHarvestProgressV3,
  DaoHarvestWitnessV3,
  JobDataV1,
} from "@ckb-automata/molecule";

type Hex = `0x${string}`;
export const DAO_HARVEST_V3_OPERATION_NAMES = Object.freeze([
  "setup",
  "preferred_prepare",
  "fallback_prepare",
  "preferred_claim",
  "fallback_claim",
  "owner_complete",
  "sweep",
  "close",
  "rotate",
  "owner_exit",
  "owner_recovery",
] as const);
export type DaoHarvestV3ProjectedOperation = (typeof DAO_HARVEST_V3_OPERATION_NAMES)[number];
export type DaoHarvestV3Lifecycle =
  "deposited" | "withdrawing" | "completed" | "owner_withdrawing" | "recovered" | "closed";

export interface DaoHarvestV3ProjectionDeployment {
  readonly networkId: string;
  readonly jobLock: Omit<ScriptIdentity, "args">;
  readonly policy: ScriptIdentity;
  readonly vaultLock: Omit<ScriptIdentity, "args">;
  readonly compensationLock: Omit<ScriptIdentity, "args">;
}
export interface DaoHarvestV3ResolvedInput {
  readonly outPoint: OutPoint;
  readonly capacity: Shannons;
  readonly lock: ScriptIdentity;
  readonly type: ScriptIdentity | null;
  readonly data: Hex;
}
export interface DaoHarvestV3ProjectionEvent {
  readonly eventId: string;
  readonly networkId: string;
  readonly jobId: Hash32;
  readonly operation: DaoHarvestV3ProjectedOperation;
  readonly transactionHash: Hash32;
  readonly transactionIndex: string;
  readonly blockNumber: string;
  readonly blockHash: Hash32;
  readonly canonical: boolean;
  readonly ownerLockHash: Hash32;
  readonly ownerLock: ScriptIdentity | null;
  readonly payoutLockHash: Hash32;
  readonly payloadHash: Hash32;
  readonly payload: Hex;
  readonly progress: Hex;
  readonly prepareCreditBytes: Hex | null;
  readonly principalCapacity: string;
  readonly compensationSeedCapacity: string;
  readonly lifecycleState: DaoHarvestV3Lifecycle;
  readonly cycleIndex: string;
  readonly totalCycles: string;
  readonly jobOutPoint: { readonly txHash: Hash32; readonly index: string } | null;
  readonly vaultOutPoint: { readonly txHash: Hash32; readonly index: string } | null;
  readonly compensationOutPoint: { readonly txHash: Hash32; readonly index: string } | null;
  readonly prepareAccumulatorOutPoint: {
    readonly txHash: Hash32;
    readonly index: string;
  } | null;
  readonly claimAccumulatorOutPoint: {
    readonly txHash: Hash32;
    readonly index: string;
  } | null;
  readonly prepareCredit: {
    readonly cycleIndex: string;
    readonly preparerLockHash: Hash32;
    readonly preparedVaultOutputIndex: string;
    readonly jobOutputIndex: string;
  } | null;
  readonly terminalOwnerControl: boolean;
}
export interface DaoHarvestV3ProjectionExtraction {
  readonly events: readonly DaoHarvestV3ProjectionEvent[];
  readonly malformed: number;
}

function witnessField(witness: string, output: boolean): Uint8Array | null {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(witness)) return null;
  const bytes = hexToBytes(witness);
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0, true);
  const inputOffset = view.getUint32(8, true);
  const outputOffset = view.getUint32(12, true);
  if (total !== bytes.length || inputOffset > outputOffset || outputOffset > total) return null;
  const start = output ? outputOffset : inputOffset;
  const end = output ? total : outputOffset;
  if (end - start < 4 || view.getUint32(start, true) !== end - start - 4) return null;
  return bytes.slice(start + 4, end);
}
function matches(
  actual: { readonly codeHash: string; readonly hashType: string } | null | undefined,
  expected: { readonly codeHash: string; readonly hashType: string },
) {
  return actual?.codeHash === expected.codeHash && actual.hashType === expected.hashType;
}
const point = (txHash: Hash32, outputIndex: number) =>
  Object.freeze({ txHash, index: String(outputIndex) });
const key = (value: OutPoint) => `${value.txHash}:${value.index}`;
function previous(value: {
  readonly txHash: { toString(): string } | string;
  readonly index: { toString(): string } | string;
}): OutPoint {
  return Object.freeze({
    txHash: parseHash32(value.txHash.toString()),
    index: parseOutputIndex(BigInt(value.index.toString())),
  });
}
function index(value: unknown): number {
  const parsed = Number(String(value));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > DAO_HARVEST_V3_ABSENT_INDEX)
    throw new RangeError("V3 witness index is invalid");
  return parsed;
}
function outputPoint(txHash: Hash32, value: number) {
  return value === DAO_HARVEST_V3_ABSENT_INDEX ? null : point(txHash, value);
}
function state(operation: number, jobOutput: number): DaoHarvestV3Lifecycle {
  if (operation === 1 || operation === 2) return "withdrawing";
  if (operation === 7) return "closed";
  if (operation === 9) return "owner_withdrawing";
  if (operation === 10) return "recovered";
  if ([3, 4, 5].includes(operation) && jobOutput === DAO_HARVEST_V3_ABSENT_INDEX)
    return "completed";
  return "deposited";
}

export function extractDaoHarvestV3ProjectionEvents(
  block: ClientBlock,
  deployment: DaoHarvestV3ProjectionDeployment,
  resolvedInputs: readonly DaoHarvestV3ResolvedInput[] = [],
): DaoHarvestV3ProjectionExtraction {
  const resolved = new Map(resolvedInputs.map((cell) => [key(cell.outPoint), cell]));
  if (resolved.size !== resolvedInputs.length)
    throw new Error("resolved V3 inputs contain duplicates");
  const events: DaoHarvestV3ProjectionEvent[] = [];
  let malformed = 0;
  const blockHash = parseHash32(block.header.hash);
  const blockNumber = BigInt(block.header.number).toString();
  for (const [transactionIndex, transaction] of block.transactions.entries()) {
    const relevantOutput = transaction.outputs.some(
      (output) =>
        matches(output.type, deployment.policy) ||
        matches(output.lock, deployment.compensationLock),
    );
    const relevantInput = transaction.inputs.some((input) => {
      const cell = resolved.get(key(previous(input.previousOutput)));
      return (
        cell !== undefined &&
        (matches(cell.type, deployment.policy) || matches(cell.lock, deployment.compensationLock))
      );
    });
    if (!relevantOutput && !relevantInput) continue;
    try {
      const inputType = witnessField(String(transaction.witnesses[0] ?? "0x"), false);
      const outputType = witnessField(String(transaction.witnesses[0] ?? "0x"), true);
      if (!inputType || !outputType) throw new Error("V3 witness fields are missing");
      const witness = DaoHarvestWitnessV3.unpack(inputType);
      const envelope = DaoHarvestEnvelopeV3.unpack(outputType);
      const operationValue = Number(witness.operation);
      const operation = DAO_HARVEST_V3_OPERATION_NAMES[operationValue];
      if (!operation || Number(witness.version) !== 3 || Number(witness.flags) !== 0)
        throw new Error("V3 witness is unsupported");
      const indices = {
        jobInputIndex: index(witness.job_input_index),
        vaultInputIndex: index(witness.vault_input_index),
        compensationInputIndex: index(witness.compensation_input_index),
        identityInputIndex: index(witness.identity_input_index),
        prepareAccumulatorInputIndex: index(witness.prepare_accumulator_input_index),
        claimAccumulatorInputIndex: index(witness.claim_accumulator_input_index),
        jobOutputIndex: index(witness.job_output_index),
        vaultOutputIndex: index(witness.vault_output_index),
        compensationOutputIndex: index(witness.compensation_output_index),
        prepareAccumulatorOutputIndex: index(witness.prepare_accumulator_output_index),
        claimAccumulatorOutputIndex: index(witness.claim_accumulator_output_index),
      };
      assertDaoHarvestV3WitnessLayout(operationValue as DaoHarvestV3Operation, indices);
      const payloadBytes =
        operationValue === 8
          ? Uint8Array.from(envelope.successor_payload)
          : Uint8Array.from(envelope.payload);
      const payload = DaoHarvestPayloadV3.unpack(payloadBytes);
      const inputProgressBytes = Uint8Array.from(envelope.progress);
      const inputProgress = DaoHarvestProgressV3.unpack(inputProgressBytes);
      const creditBytes = Uint8Array.from(envelope.prepare_credit);
      const activeProgressBytes = [1, 2].includes(operationValue)
        ? DaoHarvestProgressV3.pack({
            version: 3,
            state: 1,
            cycle_index: inputProgress.cycle_index,
            prepare_credit_hash: [...deriveDaoHarvestV3PrepareCreditHash(creditBytes)],
          })
        : [3, 4, 5].includes(operationValue) &&
            indices.jobOutputIndex !== DAO_HARVEST_V3_ABSENT_INDEX
          ? DaoHarvestProgressV3.pack({
              version: 3,
              state: 0,
              cycle_index: Number(inputProgress.cycle_index) + 1,
              prepare_credit_hash: Array(32).fill(0),
            })
          : inputProgressBytes;
      const progress = DaoHarvestProgressV3.unpack(activeProgressBytes);
      let jobId: Hash32;
      if (indices.jobOutputIndex !== DAO_HARVEST_V3_ABSENT_INDEX) {
        const jobData = JobDataV1.unpack(
          hexToBytes(String(transaction.outputsData[indices.jobOutputIndex])),
        );
        jobId = hash32FromBytes(Uint8Array.from(jobData.job_id));
      } else if (indices.jobInputIndex !== DAO_HARVEST_V3_ABSENT_INDEX) {
        const jobCell = resolved.get(
          key(previous(transaction.inputs[indices.jobInputIndex]!.previousOutput)),
        );
        if (!jobCell) throw new Error("V3 Job input is unresolved");
        jobId = hash32FromBytes(Uint8Array.from(JobDataV1.unpack(hexToBytes(jobCell.data)).job_id));
      } else {
        const compensationCell = resolved.get(
          key(previous(transaction.inputs[indices.compensationInputIndex]!.previousOutput)),
        );
        const args = hexToBytes(compensationCell?.lock.args ?? "0x");
        if (args.length !== 160) throw new Error("V3 compensation input is unresolved");
        jobId = hash32FromBytes(args.slice(0, 32));
      }
      const txHash = parseHash32(transaction.hash());
      const credit =
        creditBytes.length === 0 ? null : DaoHarvestPrepareCreditV3.unpack(creditBytes);
      const ownerLockHash = hash32FromBytes(Uint8Array.from(payload.owner_lock_hash));
      const ownerIdentity =
        indices.identityInputIndex === DAO_HARVEST_V3_ABSENT_INDEX
          ? undefined
          : resolved.get(
              key(previous(transaction.inputs[indices.identityInputIndex]!.previousOutput)),
            );
      events.push(
        Object.freeze({
          eventId: `${txHash}:${transactionIndex}:${operation}`,
          networkId: deployment.networkId,
          jobId,
          operation,
          transactionHash: txHash,
          transactionIndex: String(transactionIndex),
          blockNumber,
          blockHash,
          canonical: true,
          ownerLockHash,
          ownerLock:
            ownerIdentity !== undefined && scriptIdentityHash(ownerIdentity.lock) === ownerLockHash
              ? ownerIdentity.lock
              : null,
          payoutLockHash: hash32FromBytes(Uint8Array.from(payload.payout_lock_hash)),
          payloadHash: hash32FromBytes(Uint8Array.from(witness.payload_hash)),
          payload: bytesToHex(payloadBytes) as Hex,
          progress: bytesToHex(activeProgressBytes) as Hex,
          prepareCreditBytes: creditBytes.length === 0 ? null : (bytesToHex(creditBytes) as Hex),
          principalCapacity: BigInt(payload.principal_capacity.toString()).toString(),
          compensationSeedCapacity: BigInt(
            payload.compensation_seed_capacity.toString(),
          ).toString(),
          lifecycleState: state(operationValue, indices.jobOutputIndex),
          cycleIndex: BigInt(progress.cycle_index.toString()).toString(),
          totalCycles: BigInt(payload.total_cycles.toString()).toString(),
          jobOutPoint: outputPoint(txHash, indices.jobOutputIndex),
          vaultOutPoint: outputPoint(txHash, indices.vaultOutputIndex),
          compensationOutPoint: outputPoint(txHash, indices.compensationOutputIndex),
          prepareAccumulatorOutPoint: outputPoint(txHash, indices.prepareAccumulatorOutputIndex),
          claimAccumulatorOutPoint: outputPoint(txHash, indices.claimAccumulatorOutputIndex),
          prepareCredit:
            credit === null
              ? null
              : Object.freeze({
                  cycleIndex: BigInt(credit.cycle_index.toString()).toString(),
                  preparerLockHash: hash32FromBytes(Uint8Array.from(credit.preparer_lock_hash)),
                  preparedVaultOutputIndex: BigInt(
                    credit.prepared_vault_output_index.toString(),
                  ).toString(),
                  jobOutputIndex: BigInt(credit.job_output_index.toString()).toString(),
                }),
          terminalOwnerControl:
            operationValue === 9 ||
            operationValue === 10 ||
            ([3, 4, 5].includes(operationValue) &&
              indices.jobOutputIndex === DAO_HARVEST_V3_ABSENT_INDEX),
        }),
      );
    } catch {
      malformed += 1;
    }
  }
  return Object.freeze({ events: Object.freeze(events), malformed });
}

export function rebuildDaoHarvestV3Snapshot(events: readonly DaoHarvestV3ProjectionEvent[]) {
  const canonical = events
    .filter((event) => event.canonical)
    .toSorted((left, right) =>
      BigInt(left.blockNumber) === BigInt(right.blockNumber)
        ? Number(left.transactionIndex) - Number(right.transactionIndex)
        : BigInt(left.blockNumber) < BigInt(right.blockNumber)
          ? -1
          : 1,
    );
  const latest = canonical.at(-1);
  if (!latest) return null;
  if (canonical.some((event) => event.jobId !== latest.jobId))
    throw new Error("cannot rebuild a snapshot from multiple V3 jobs");
  const ownerLock = canonical.find((event) => event.ownerLock !== null)?.ownerLock ?? null;
  return Object.freeze({ ...latest, ownerLock, sourceEventCount: canonical.length });
}
