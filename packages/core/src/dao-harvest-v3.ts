import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

export const DAO_HARVEST_V3_VERSION = 3 as const;
export const DAO_HARVEST_V3_ABSENT_INDEX = 0xffff_ffff as const;
export const DAO_HARVEST_V3_COMPENSATION_ARGS_BYTES = 160 as const;
export const DAO_HARVEST_V3_VAULT_ARGS_BYTES = 160 as const;
export const MAX_DAO_HARVEST_V3_FALLBACK_OPERATORS = 8 as const;

export const DAO_HARVEST_V3_DOMAINS = Object.freeze({
  payload: "ckb-automata/dao-harvest-payload/v3",
  progress: "ckb-automata/dao-harvest-progress/v3",
  prepareCredit: "ckb-automata/dao-harvest-prepare-credit/v3",
  fallbackSet: "ckb-automata/dao-harvest-fallback-set/v3",
  vaultTerms: "ckb-automata/dao-harvest-vault-terms/v3",
  intent: "ckb-automata/dao-harvest-intent/v3",
} as const);

export const DAO_HARVEST_V3_OPERATIONS = Object.freeze({
  SETUP: 0,
  PREFERRED_PREPARE: 1,
  FALLBACK_PREPARE: 2,
  PREFERRED_CLAIM: 3,
  FALLBACK_CLAIM: 4,
  OWNER_COMPLETE: 5,
  SWEEP: 6,
  CLOSE: 7,
  ROTATE: 8,
  OWNER_EXIT: 9,
  OWNER_RECOVERY: 10,
} as const);

export const DAO_HARVEST_V3_STATES = Object.freeze({ DEPOSITED: 0, WITHDRAWING: 1 } as const);
export type DaoHarvestV3Operation =
  (typeof DAO_HARVEST_V3_OPERATIONS)[keyof typeof DAO_HARVEST_V3_OPERATIONS];

const BYTE32_LENGTH = 32;
function byte32(value: Uint8Array, name: string): Uint8Array {
  if (value.length !== BYTE32_LENGTH) throw new RangeError(`${name} must contain exactly 32 bytes`);
  return value;
}

function hashDomain(domain: string, parts: readonly Uint8Array[]): Uint8Array {
  const bodyLength = parts.reduce((total, part) => total + part.length, 0);
  if (!Number.isSafeInteger(bodyLength) || bodyLength > 0xffff_ffff)
    throw new RangeError("hash body exceeds uint32 length");
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bodyLength, true);
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(domain));
  hasher.update(Uint8Array.of(0));
  hasher.update(length);
  for (const part of parts) hasher.update(part);
  return hasher.digest("binary") as Uint8Array;
}

export const deriveDaoHarvestV3PayloadHash = (policyHash: Uint8Array, payload: Uint8Array) =>
  hashDomain(DAO_HARVEST_V3_DOMAINS.payload, [byte32(policyHash, "policyScriptHash"), payload]);
export const deriveDaoHarvestV3ProgressHash = (progress: Uint8Array) =>
  hashDomain(DAO_HARVEST_V3_DOMAINS.progress, [progress]);
export const deriveDaoHarvestV3PrepareCreditHash = (credit: Uint8Array) =>
  hashDomain(DAO_HARVEST_V3_DOMAINS.prepareCredit, [credit]);
export const deriveDaoHarvestV3IntentHash = (intent: Uint8Array) =>
  hashDomain(DAO_HARVEST_V3_DOMAINS.intent, [intent]);
export const deriveDaoHarvestV3VaultTermsHash = (parts: readonly Uint8Array[]) =>
  hashDomain(DAO_HARVEST_V3_DOMAINS.vaultTerms, parts);

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function normalizeDaoHarvestV3FallbackOperators(values: readonly Uint8Array[]) {
  if (values.length === 0 || values.length > MAX_DAO_HARVEST_V3_FALLBACK_OPERATORS)
    throw new RangeError("fallback operator set must contain 1 to 8 identities");
  const normalized = values
    .map((value, index) => Uint8Array.from(byte32(value, `operatorLockHashes[${index}]`)))
    .toSorted(compareBytes);
  if (
    normalized.some(
      (value, index) => index > 0 && compareBytes(normalized[index - 1]!, value) === 0,
    )
  )
    throw new RangeError("fallback operator set contains a duplicate identity");
  return Object.freeze(normalized);
}

export function deriveDaoHarvestV3FallbackOperatorSetHash(values: readonly Uint8Array[]) {
  const normalized = normalizeDaoHarvestV3FallbackOperators(values);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, normalized.length, true);
  return hashDomain(DAO_HARVEST_V3_DOMAINS.fallbackSet, [count, ...normalized]);
}

export function encodeDaoHarvestV3FallbackOperatorProof(values: readonly Uint8Array[]) {
  const normalized = normalizeDaoHarvestV3FallbackOperators(values);
  const proof = new Uint8Array(normalized.length * BYTE32_LENGTH);
  normalized.forEach((operator, index) => proof.set(operator, index * BYTE32_LENGTH));
  return proof;
}

export interface DaoHarvestV3LockArgs {
  readonly parts: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
}
export function encodeDaoHarvestV3LockArgs(input: DaoHarvestV3LockArgs): Uint8Array {
  const encoded = new Uint8Array(160);
  input.parts.forEach((part, index) => encoded.set(byte32(part, `parts[${index}]`), index * 32));
  return encoded;
}

export interface DaoHarvestV3WitnessIndices {
  readonly jobInputIndex: number;
  readonly vaultInputIndex: number;
  readonly compensationInputIndex: number;
  readonly identityInputIndex: number;
  readonly prepareAccumulatorInputIndex: number;
  readonly claimAccumulatorInputIndex: number;
  readonly jobOutputIndex: number;
  readonly vaultOutputIndex: number;
  readonly compensationOutputIndex: number;
  readonly prepareAccumulatorOutputIndex: number;
  readonly claimAccumulatorOutputIndex: number;
}

const INDEX_KEYS = [
  "jobInputIndex",
  "vaultInputIndex",
  "compensationInputIndex",
  "identityInputIndex",
  "prepareAccumulatorInputIndex",
  "claimAccumulatorInputIndex",
  "jobOutputIndex",
  "vaultOutputIndex",
  "compensationOutputIndex",
  "prepareAccumulatorOutputIndex",
  "claimAccumulatorOutputIndex",
] as const;
const REQUIRED: Readonly<Record<DaoHarvestV3Operation, readonly number[]>> = Object.freeze({
  0: [3, 6, 7, 8],
  1: [0, 1, 3, 4, 6, 7, 9],
  2: [0, 1, 3, 4, 6, 7, 9],
  3: [0, 1, 2, 3, 4, 7, 8, 9],
  4: [0, 1, 2, 3, 4, 5, 7, 8, 9, 10],
  5: [0, 1, 2, 3, 4, 7, 8, 9],
  6: [0, 2, 3, 6, 8],
  7: [2, 3],
  8: [0, 2, 3, 6, 8],
  9: [0, 1, 2, 3, 7],
  10: [0, 1, 2, 3, 4, 9],
});

export function assertDaoHarvestV3WitnessLayout(
  operation: DaoHarvestV3Operation,
  indices: DaoHarvestV3WitnessIndices,
): void {
  const required = REQUIRED[operation];
  INDEX_KEYS.forEach((key, index) => {
    const value = indices[key];
    if (!Number.isInteger(value) || value < 0 || value > DAO_HARVEST_V3_ABSENT_INDEX)
      throw new RangeError(`${key} is not a uint32 index`);
    const optional =
      (([3, 4, 5] as number[]).includes(operation) && index === 6) ||
      (operation === 3 && (index === 5 || index === 10));
    if (
      required.includes(index)
        ? value === DAO_HARVEST_V3_ABSENT_INDEX
        : !optional && value !== DAO_HARVEST_V3_ABSENT_INDEX
    )
      throw new RangeError(`${key} is invalid for DAO Harvest V3 operation ${operation}`);
  });
  if (
    (indices.prepareAccumulatorInputIndex === DAO_HARVEST_V3_ABSENT_INDEX) !==
    (indices.prepareAccumulatorOutputIndex === DAO_HARVEST_V3_ABSENT_INDEX)
  )
    throw new RangeError("prepare accumulator input and output must form a pair");
  if (
    (indices.claimAccumulatorInputIndex === DAO_HARVEST_V3_ABSENT_INDEX) !==
    (indices.claimAccumulatorOutputIndex === DAO_HARVEST_V3_ABSENT_INDEX)
  )
    throw new RangeError("claim accumulator input and output must form a pair");
}

export const absentDaoHarvestV3Indices = (): DaoHarvestV3WitnessIndices =>
  Object.freeze({
    jobInputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    vaultInputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    compensationInputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    identityInputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    prepareAccumulatorInputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    claimAccumulatorInputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    jobOutputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    vaultOutputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    compensationOutputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    prepareAccumulatorOutputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
    claimAccumulatorOutputIndex: DAO_HARVEST_V3_ABSENT_INDEX,
  });
