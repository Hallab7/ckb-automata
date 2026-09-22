import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

import {
  hash32ToBytes,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseOutputIndex,
  parseShannons,
  type BlockNumber,
  type Hash32,
  type OutPoint,
  type OutputIndex,
  type Shannons,
} from "./chain-values.ts";

export const CAMPAIGN_ID_DOMAIN = "ckb-automata/campaign-id/v1" as const;
export const CAMPAIGN_REFUNDS_DOMAIN = "ckb-automata/campaign-refunds/v1" as const;
export const DEADLINE_PAYLOAD_VERSION = 1 as const;
export const POLICY_PAYLOAD_DOMAIN = "ckb-automata/policy-payload/v1" as const;

export const CAMPAIGN_STATES = {
  OPEN: 0,
  SUCCEEDED: 1,
  REFUNDING: 2,
} as const;

export type CampaignOutcome = "SUCCEEDED" | "REFUNDING";

function littleEndian(value: bigint, byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  new DataView(result.buffer).setUint32(0, Number(value & 0xffff_ffffn), true);
  if (byteLength === 8) {
    new DataView(result.buffer).setBigUint64(0, value, true);
  }
  return result;
}

function concatenate(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function protocolHash(domain: string, body: Uint8Array): Uint8Array {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(domain));
  hasher.update(Uint8Array.of(0));
  hasher.update(littleEndian(BigInt(body.length), 4));
  hasher.update(body);
  return hasher.digest("binary") as Uint8Array;
}

export function encodeOutPoint(outPointValue: OutPoint): Uint8Array {
  const outPoint = parseOutPoint(outPointValue);
  return concatenate(hash32ToBytes(outPoint.txHash), littleEndian(outPoint.index, 4));
}

export function deriveCampaignId(
  anchorOutPoint: OutPoint,
  campaignOutputIndex: OutputIndex,
): Uint8Array {
  const outputIndex = parseOutputIndex(campaignOutputIndex);
  return protocolHash(
    CAMPAIGN_ID_DOMAIN,
    concatenate(encodeOutPoint(anchorOutPoint), littleEndian(outputIndex, 4)),
  );
}

export function deriveRefundCommitment(pledgeCount: number, records: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(pledgeCount) || pledgeCount <= 0 || pledgeCount > 0xffff_ffff) {
    throw new RangeError("pledgeCount must be a positive uint32 integer");
  }
  if (records.length !== pledgeCount * 76) {
    throw new RangeError("pledge records must contain exactly 76 bytes per pledge");
  }
  return protocolHash(
    CAMPAIGN_REFUNDS_DOMAIN,
    concatenate(littleEndian(BigInt(pledgeCount), 4), records),
  );
}

export function deriveDeadlinePayloadHash(
  policyScriptHash: Hash32,
  campaignTypeHash: Hash32,
): Uint8Array {
  return protocolHash(
    POLICY_PAYLOAD_DOMAIN,
    concatenate(
      hash32ToBytes(parseHash32(policyScriptHash)),
      Uint8Array.of(DEADLINE_PAYLOAD_VERSION),
      hash32ToBytes(parseHash32(campaignTypeHash)),
    ),
  );
}

export function determineCampaignOutcome(pledged: Shannons, target: Shannons): CampaignOutcome {
  const pledgedValue = parseShannons(pledged);
  const targetValue = parseShannons(target);
  if (targetValue <= 0n) {
    throw new RangeError("target must be greater than zero");
  }
  return pledgedValue >= targetValue ? "SUCCEEDED" : "REFUNDING";
}

export function isAbsoluteBlockDeadline(deadlineSince: BlockNumber): boolean {
  const deadline = parseBlockNumber(deadlineSince);
  const maximumAbsoluteBlock = (1n << 56n) - 1n;
  return deadline > 0n && deadline <= maximumAbsoluteBlock;
}
