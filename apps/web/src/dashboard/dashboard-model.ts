import type { ApiJobList } from "@ckb-automata/api-client";

import { formatCkbBalance } from "../ccc/wallet-display.ts";
import {
  estimateBlockDate,
  formatBlockDate,
  formatBlockDuration,
  formatDateTime,
} from "../time/chain-time.ts";

export type DashboardJob = ApiJobList["items"][number];
export interface RecipientAmounts {
  readonly perExecution: string;
  readonly total: string;
}
export type RecipientAmountsByJob = Readonly<Record<string, RecipientAmounts | null>>;
export type DashboardStatus =
  "completed" | "needs_funding" | "processing" | "recovery_required" | "reorged" | "waiting";

export interface DashboardJobPresentation {
  readonly recipientAmount: string;
  readonly nextAction: string;
  readonly nextSchedule: string;
  readonly runsRemaining: string;
  readonly scheduledAt?: string;
  readonly status: DashboardStatus;
  readonly timeRemaining: string;
}

export interface DashboardSummary {
  readonly recipientTotal: string;
  readonly live: number;
  readonly orphaned: number;
  readonly spent: number;
  readonly total: number;
}

export function dashboardJobPresentation(
  job: DashboardJob,
  checkpointBlock: string | undefined,
  recipientAmounts: RecipientAmounts | null | undefined,
  checkpointAt = job.updatedAt,
): DashboardJobPresentation {
  const formattedRecipientAmount =
    recipientAmounts === undefined
      ? "Loading..."
      : recipientAmounts === null
        ? "Unavailable"
        : formatCkbBalance(BigInt(recipientAmounts.perExecution));
  const checkpoint = checkpointBlock === undefined ? undefined : BigInt(checkpointBlock);
  const notBefore = BigInt(job.trigger.notBefore);
  const notAfter = BigInt(job.trigger.notAfter);
  const scheduledAt =
    checkpoint === undefined
      ? undefined
      : estimateBlockDate(notBefore, checkpoint, checkpointAt)?.toISOString();
  if (job.state === "orphaned") {
    return {
      recipientAmount: formattedRecipientAmount,
      nextAction: "Wait for canonical replay",
      nextSchedule: "Schedule being rechecked",
      runsRemaining: job.remainingRuns,
      ...(scheduledAt === undefined ? {} : { scheduledAt }),
      status: "reorged",
      timeRemaining: "Rechecking",
    };
  }
  if (job.state === "spent") {
    return {
      recipientAmount: formattedRecipientAmount,
      nextAction: "Review execution history",
      nextSchedule: `Completed ${formatDateTime(job.updatedAt)}`,
      runsRemaining: "0",
      ...(scheduledAt === undefined ? {} : { scheduledAt }),
      status: "completed",
      timeRemaining: "Complete",
    };
  }

  const remainingBudget = BigInt(job.funds.remainingBudget);
  const reward = BigInt(job.funds.executorReward);
  let status: DashboardStatus;
  let nextAction: string;
  let nextSchedule: string;
  let timeRemaining: string;

  if (checkpoint !== undefined && notAfter !== 0n && checkpoint > notAfter) {
    status = "recovery_required";
    nextAction = "Recover remaining funds";
    nextSchedule = "Scheduled window ended";
    timeRemaining = "Action needed";
  } else if (remainingBudget < reward) {
    status = "needs_funding";
    nextAction = "Top up executor budget";
    nextSchedule = "Payment needs service funds";
    timeRemaining = "Action needed";
  } else if (checkpoint !== undefined && checkpoint >= notBefore) {
    status = "processing";
    nextAction = "Payment execution is in progress";
    nextSchedule =
      scheduledAt === undefined
        ? "Processing now"
        : `Processing since ${formatBlockDate(notBefore, checkpoint, checkpointAt)}`;
    timeRemaining = "Now";
  } else {
    status = "waiting";
    nextAction = "Waiting for the scheduled time";
    nextSchedule =
      checkpoint === undefined
        ? "Schedule time syncing"
        : formatBlockDate(notBefore, checkpoint, checkpointAt);
    timeRemaining =
      checkpoint === undefined ? "Syncing" : formatBlockDuration(notBefore - checkpoint);
  }

  return {
    recipientAmount: formattedRecipientAmount,
    nextAction,
    nextSchedule,
    runsRemaining: job.remainingRuns,
    ...(scheduledAt === undefined ? {} : { scheduledAt }),
    status,
    timeRemaining,
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
