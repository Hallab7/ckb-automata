export const CAMPAIGN_STATES = {
  OPEN: 0,
  SUCCEEDED: 1,
  REFUNDING: 2,
} as const;

export type CampaignOutcome = "SUCCEEDED" | "REFUNDING";

export function determineCampaignOutcome(pledged: bigint, target: bigint): CampaignOutcome {
  if (pledged < 0n) {
    throw new RangeError("pledged must not be negative");
  }
  if (target <= 0n) {
    throw new RangeError("target must be greater than zero");
  }
  return pledged >= target ? "SUCCEEDED" : "REFUNDING";
}

export function isAbsoluteBlockDeadline(deadlineSince: bigint): boolean {
  const maximumAbsoluteBlock = (1n << 56n) - 1n;
  return deadlineSince > 0n && deadlineSince <= maximumAbsoluteBlock;
}
