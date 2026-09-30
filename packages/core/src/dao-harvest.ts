import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

export const DAO_HARVEST_PAYLOAD_VERSION = 1 as const;
export const DAO_HARVEST_PAYLOAD_DOMAIN = "ckb-automata/policy-payload/v1" as const;
export const DAO_HARVEST_EXECUTOR_SET_DOMAIN = "ckb-automata/dao-harvest-executors/v1" as const;
export const MAX_DAO_HARVEST_PREPARE_EXECUTORS = 8 as const;

export const DAO_HARVEST_OPERATIONS = Object.freeze({
  PREPARE: 0,
  ROLL: 1,
  OWNER_STOP: 2,
  OWNER_EXIT: 3,
  OWNER_RECOVER: 4,
} as const);

export const DAO_HARVEST_DAO_STATES = Object.freeze({
  DEPOSITED: "deposited",
  WITHDRAWING: "withdrawing",
} as const);

export type DaoHarvestOperation =
  (typeof DAO_HARVEST_OPERATIONS)[keyof typeof DAO_HARVEST_OPERATIONS];
export type DaoHarvestDaoState =
  (typeof DAO_HARVEST_DAO_STATES)[keyof typeof DAO_HARVEST_DAO_STATES];

const BYTE32_LENGTH = 32;
const MAX_UINT32 = 0xffff_ffff;

function requireByte32(value: Uint8Array, name: string): Uint8Array {
  if (value.length !== BYTE32_LENGTH) {
    throw new RangeError(`${name} must contain exactly 32 bytes`);
  }
  return value;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function hashDomain(domain: string, body: Uint8Array): Uint8Array {
  if (body.length > MAX_UINT32) throw new RangeError("hash body exceeds uint32 length");
  const encodedLength = new Uint8Array(4);
  new DataView(encodedLength.buffer).setUint32(0, body.length, true);
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(domain));
  hasher.update(Uint8Array.of(0));
  hasher.update(encodedLength);
  hasher.update(body);
  return hasher.digest("binary") as Uint8Array;
}

export function deriveDaoHarvestPayloadHash(
  policyScriptHash: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  const policyHash = requireByte32(policyScriptHash, "policyScriptHash");
  const body = new Uint8Array(policyHash.length + payload.length);
  body.set(policyHash);
  body.set(payload, policyHash.length);
  return hashDomain(DAO_HARVEST_PAYLOAD_DOMAIN, body);
}

export function normalizePrepareExecutorSet(
  executorLockHashes: readonly Uint8Array[],
): readonly Uint8Array[] {
  if (
    executorLockHashes.length === 0 ||
    executorLockHashes.length > MAX_DAO_HARVEST_PREPARE_EXECUTORS
  ) {
    throw new RangeError(
      `prepare executor set must contain 1 to ${MAX_DAO_HARVEST_PREPARE_EXECUTORS} identities`,
    );
  }
  const normalized = executorLockHashes
    .map((value, index) => Uint8Array.from(requireByte32(value, `executorLockHashes[${index}]`)))
    .toSorted(compareBytes);
  for (let index = 1; index < normalized.length; index += 1) {
    if (compareBytes(normalized[index - 1]!, normalized[index]!) === 0) {
      throw new RangeError("prepare executor set contains a duplicate identity");
    }
  }
  return Object.freeze(normalized);
}

export function derivePrepareExecutorSetHash(
  executorLockHashes: readonly Uint8Array[],
): Uint8Array {
  const normalized = normalizePrepareExecutorSet(executorLockHashes);
  const body = new Uint8Array(4 + normalized.length * BYTE32_LENGTH);
  new DataView(body.buffer).setUint32(0, normalized.length, true);
  normalized.forEach((identity, index) => body.set(identity, 4 + index * BYTE32_LENGTH));
  return hashDomain(DAO_HARVEST_EXECUTOR_SET_DOMAIN, body);
}

export function classifyDaoHarvestCellData(data: Uint8Array): DaoHarvestDaoState {
  if (data.length !== 8) throw new RangeError("Nervos DAO cell data must contain exactly 8 bytes");
  return data.every((byte) => byte === 0)
    ? DAO_HARVEST_DAO_STATES.DEPOSITED
    : DAO_HARVEST_DAO_STATES.WITHDRAWING;
}
