import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

import {
  parseBlockNumber,
  parseRunCount,
  parseShannons,
  type BlockNumber,
  type RunCount,
  type Shannons,
} from "./chain-values.ts";

export const POLICY_PAYLOAD_DOMAIN = "ckb-automata/policy-payload/v1" as const;

const BYTE32_LENGTH = 32;
const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT32_BIGINT = 0xffff_ffffn;
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
  readonly amount: Shannons;
  readonly intervalBlocks: BlockNumber;
  readonly firstNotBefore: BlockNumber;
  readonly totalRuns: RunCount;
  readonly finalRefundKind: number;
}

export function isValidRecurringSchedule(schedule: RecurringSchedule): boolean {
  try {
    const amount = parseShannons(schedule.amount);
    const intervalBlocks = parseBlockNumber(schedule.intervalBlocks);
    const firstNotBefore = parseBlockNumber(schedule.firstNotBefore);
    const totalRuns = parseRunCount(schedule.totalRuns);
    return (
      amount > 0n &&
      intervalBlocks > 0n &&
      firstNotBefore > 0n &&
      firstNotBefore <= MAX_ABSOLUTE_BLOCK_NUMBER &&
      totalRuns > 0n &&
      totalRuns <= MAX_UINT32_BIGINT &&
      schedule.finalRefundKind === 0
    );
  } catch {
    return false;
  }
}
