import type { ApiJobList } from "@ckb-automata/api-client";

import { formatCkbBalance } from "../ccc/wallet-display.ts";

export type DashboardJob = ApiJobList["items"][number];
export interface RecipientAmounts {
  readonly perExecution: string;
  readonly total: string;
}
export type RecipientAmountsByJob = Readonly<Record<string, RecipientAmounts | null>>;
export type DashboardStatus =
  "completed" | "eligible" | "needs_funding" | "recovery_required" | "reorged" | "waiting";

export interface DashboardJobPresentation {
  readonly recipientAmount: string;
  readonly nextAction: string;
  readonly nextEligibility: string;
  readonly status: DashboardStatus;
}

export interface DashboardSummary {
  readonly recipientTotal: string;
  readonly live: number;
  readonly orphaned: number;
  readonly spent: number;
  readonly total: number;
}

function blockLabel(value: bigint): string {
  return `Block #${value.toLocaleString("en-US")}`;
}

export function dashboardJobPresentation(
  job: DashboardJob,
  checkpointBlock: string | undefined,
  recipientAmounts: RecipientAmounts | null | undefined,
): DashboardJobPresentation {
  const formattedRecipientAmount =
    recipientAmounts === undefined
      ? "Loading..."
      : recipientAmounts === null
        ? "Unavailable"
        : formatCkbBalance(BigInt(recipientAmounts.perExecution));
  if (job.state === "orphaned") {
    return {
      recipientAmount: formattedRecipientAmount,
      nextAction: "Wait for canonical replay",
      nextEligibility: "Canonical status pending",
      status: "reorged",
    };
  }
  if (job.state === "spent") {
    return {
      recipientAmount: formattedRecipientAmount,
      nextAction: "Review execution history",
      nextEligibility: "No further execution",
      status: "completed",
    };
  }

  const checkpoint = checkpointBlock === undefined ? undefined : BigInt(checkpointBlock);
  const notBefore = BigInt(job.trigger.notBefore);
  const notAfter = BigInt(job.trigger.notAfter);
  const remainingBudget = BigInt(job.funds.remainingBudget);
  const reward = BigInt(job.funds.executorReward);
  let status: DashboardStatus;
  let nextAction: string;
  let nextEligibility: string;

  if (checkpoint !== undefined && notAfter !== 0n && checkpoint > notAfter) {
    status = "recovery_required";
    nextAction = "Recover remaining funds";
    nextEligibility = "Execution window closed";
  } else if (remainingBudget < reward) {
    status = "needs_funding";
    nextAction = "Top up executor budget";
    nextEligibility = "Blocked by funding";
  } else if (checkpoint !== undefined && checkpoint >= notBefore) {
    status = "eligible";
    nextAction = "Monitor executor submission";
    nextEligibility = `Eligible at ${blockLabel(notBefore)}`;
  } else {
    status = "waiting";
    nextAction = "Wait for chain eligibility";
    nextEligibility =
      checkpoint === undefined
        ? blockLabel(notBefore)
        : `${blockLabel(notBefore)} (${(notBefore - checkpoint).toLocaleString("en-US")} blocks)`;
  }

  return {
    recipientAmount: formattedRecipientAmount,
    nextAction,
    nextEligibility,
    status,
  };
}

export function dashboardSummary(
  items: readonly DashboardJob[],
  recipientAmounts: RecipientAmountsByJob,
): DashboardSummary {
  const counts = { live: 0, orphaned: 0, spent: 0 };
  let recipientTotal = 0n;
  let hasLoadingAmount = false;
  let hasUnavailableAmount = false;
  for (const item of items) {
    counts[item.state] += 1;
    const amounts = recipientAmounts[item.jobId];
    if (amounts === undefined) hasLoadingAmount = true;
    else if (amounts === null) hasUnavailableAmount = true;
    else recipientTotal += BigInt(amounts.total);
  }
  return {
    recipientTotal: hasUnavailableAmount
      ? "Unavailable"
      : hasLoadingAmount
        ? "Loading..."
        : formatCkbBalance(recipientTotal),
    ...counts,
    total: items.length,
  };
}

export function shortJobId(jobId: string): string {
  return jobId.length <= 22 ? jobId : `${jobId.slice(0, 10)}...${jobId.slice(-8)}`;
}
