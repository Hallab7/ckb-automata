import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

import {
  packEpoch,
  parseBlockNumber,
  parseEpoch,
  type BlockNumber,
  type Epoch,
  type EpochValue,
  type IntegerInput,
} from "./chain-values.ts";

export const ABSOLUTE_BLOCK_TRIGGER_KIND = 1 as const;
export const ABSOLUTE_EPOCH_TRIGGER_KIND = 2 as const;
export const TRIGGER_PARAMS_DOMAIN = "ckb-automata/trigger-params/v1" as const;

const EPOCH_METRIC = 0b01n << 61n;
const RELATIVE_FLAG = 1n << 63n;

function triggerHash(kind: number, notBefore: bigint): Uint8Array {
  const body = new Uint8Array(10);
  const view = new DataView(body.buffer);
  view.setUint16(0, kind, true);
  view.setBigUint64(2, notBefore, true);

  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, body.length, true);
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(TRIGGER_PARAMS_DOMAIN));
  hasher.update(Uint8Array.of(0));
  hasher.update(length);
  hasher.update(body);
  return hasher.digest("binary") as Uint8Array;
}

export function deriveAbsoluteBlockTriggerHash(notBeforeValue: BlockNumber): Uint8Array {
  const notBefore = parseBlockNumber(notBeforeValue);
  return triggerHash(ABSOLUTE_BLOCK_TRIGGER_KIND, notBefore);
}

export function encodeAbsoluteEpochSince(epoch: Epoch): EpochValue {
  return (EPOCH_METRIC | packEpoch(epoch)) as EpochValue;
}

export function decodeAbsoluteEpochSince(value: IntegerInput): Epoch {
  const parsed = BigInt(value);
  if ((parsed & (0b11n << 61n)) !== EPOCH_METRIC || (parsed & (0x1fn << 56n)) !== 0n) {
    throw new RangeError("value is not a canonical absolute epoch since");
  }
  return parseEpoch(parsed & ((1n << 56n) - 1n));
}

export function deriveAbsoluteEpochTriggerHash(notBeforeValue: IntegerInput): Uint8Array {
  const notBefore = BigInt(notBeforeValue);
  decodeAbsoluteEpochSince(notBefore);
  return triggerHash(ABSOLUTE_EPOCH_TRIGGER_KIND, notBefore);
}

export function encodeRelativeEpochSince(epoch: Epoch): EpochValue {
  if (epoch.number === 0n && epoch.index === 0n) {
    throw new RangeError("relative epoch duration must be positive");
  }
  return (RELATIVE_FLAG | EPOCH_METRIC | packEpoch(epoch)) as EpochValue;
}

export function decodeRelativeEpochSince(value: IntegerInput): Epoch {
  const parsed = BigInt(value);
  if (
    (parsed & RELATIVE_FLAG) === 0n ||
    (parsed & (0b11n << 61n)) !== EPOCH_METRIC ||
    (parsed & (0x1fn << 56n)) !== 0n
  ) {
    throw new RangeError("value is not a canonical relative epoch since");
  }
  const epoch = parseEpoch(parsed & ((1n << 56n) - 1n));
  if (epoch.number === 0n && epoch.index === 0n) {
    throw new RangeError("relative epoch duration must be positive");
  }
  return epoch;
}
