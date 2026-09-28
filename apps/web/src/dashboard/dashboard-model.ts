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
  | "completed"
  | "confirming"
  | "needs_funding"
  | "processing"
  | "recovery_required"
  | "reorged"
  | "submitting"
  | "waiting";

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
  readonly confirming: number;
  readonly recipientTotal: string;
  readonly live: number;
  readonly orphaned: number;
  readonly spent: number;
  readonly submitting: number;
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

export function dashboardSummary(summary: ApiJobList["summary"]): DashboardSummary {
  return {
    recipientTotal:
      summary.recipientTotal === null
        ? "Temporarily unavailable"
        : formatCkbBalance(BigInt(summary.recipientTotal)),
    ...summary.states,
    total: summary.totalItems,
  };
}

export function dashboardPageRange(
  pageIndex: number,
  pageSize: number,
  itemCount: number,
  totalItems: number,
): { readonly first: number; readonly last: number; readonly totalPages: number } {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new RangeError("invalid page index");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("invalid page size");
  if (!Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > pageSize) {
    throw new RangeError("invalid page item count");
  }
  if (!Number.isSafeInteger(totalItems) || totalItems < 0) {
    throw new RangeError("invalid total item count");
  }
  return Object.freeze({
    first: itemCount === 0 ? 0 : pageIndex * pageSize + 1,
    last: itemCount === 0 ? 0 : Math.min(pageIndex * pageSize + itemCount, totalItems),
    totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
  });
}

export function shortJobId(jobId: string): string {
  return jobId.length <= 22 ? jobId : `${jobId.slice(0, 10)}...${jobId.slice(-8)}`;
}
