import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

import { parseBlockNumber, type BlockNumber } from "./chain-values.ts";

export const ABSOLUTE_BLOCK_TRIGGER_KIND = 1 as const;
export const TRIGGER_PARAMS_DOMAIN = "ckb-automata/trigger-params/v1" as const;

export function deriveAbsoluteBlockTriggerHash(notBeforeValue: BlockNumber): Uint8Array {
  const notBefore = parseBlockNumber(notBeforeValue);
  const body = new Uint8Array(10);
  const view = new DataView(body.buffer);
  view.setUint16(0, ABSOLUTE_BLOCK_TRIGGER_KIND, true);
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
