import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

export const POLICY_PAYLOAD_DOMAIN = "ckb-automata/policy-payload/v1" as const;

const BYTE32_LENGTH = 32;
const MAX_UINT32 = 0xffff_ffff;
const MAX_ABSOLUTE_BLOCK_NUMBER = (1n << 56n) - 1n;

function requireByte32(value: Uint8Array, name: string): Uint8Array {
  if (value.length !== BYTE32_LENGTH) {
    throw new RangeError(`${name} must contain exactly 32 bytes`);
  }
  return value;
}

export function deriveRecurringPayloadHash(
  policyScriptHash: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  const policyHash = requireByte32(policyScriptHash, "policyScriptHash");
  const bodyLength = policyHash.length + payload.length;
  if (bodyLength > MAX_UINT32) {
    throw new RangeError("recurring payload commitment exceeds uint32 length");
  }
  const encodedLength = new Uint8Array(4);
  new DataView(encodedLength.buffer).setUint32(0, bodyLength, true);

  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(POLICY_PAYLOAD_DOMAIN));
  hasher.update(Uint8Array.of(0));
  hasher.update(encodedLength);
  hasher.update(policyHash);
  hasher.update(payload);
  return hasher.digest("binary") as Uint8Array;
}

export interface RecurringSchedule {
  readonly amount: bigint;
  readonly intervalBlocks: bigint;
  readonly firstNotBefore: bigint;
  readonly totalRuns: number;
  readonly finalRefundKind: number;
}

export function isValidRecurringSchedule(schedule: RecurringSchedule): boolean {
  return (
    schedule.amount > 0n &&
    schedule.intervalBlocks > 0n &&
    schedule.firstNotBefore > 0n &&
    schedule.firstNotBefore <= MAX_ABSOLUTE_BLOCK_NUMBER &&
    Number.isInteger(schedule.totalRuns) &&
    schedule.totalRuns > 0 &&
    schedule.totalRuns <= MAX_UINT32 &&
    schedule.finalRefundKind === 0
  );
}
