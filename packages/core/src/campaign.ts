import {
  parseBlockNumber,
  parseShannons,
  type BlockNumber,
  type Shannons,
} from "./chain-values.ts";

export const CAMPAIGN_STATES = {
  OPEN: 0,
  SUCCEEDED: 1,
  REFUNDING: 2,
} as const;

export type CampaignOutcome = "SUCCEEDED" | "REFUNDING";

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
