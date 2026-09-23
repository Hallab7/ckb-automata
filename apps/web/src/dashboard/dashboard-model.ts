import type { ApiJobList } from "@ckb-automata/api-client";

import { formatCkbBalance } from "../ccc/wallet-display.ts";

export type DashboardJob = ApiJobList["items"][number];
export type DashboardStatus =
  "completed" | "eligible" | "needs_funding" | "recovery_required" | "reorged" | "waiting";

export interface DashboardJobPresentation {
  readonly fundedValue: string;
  readonly nextAction: string;
  readonly nextEligibility: string;
  readonly status: DashboardStatus;
}

export interface DashboardSummary {
  readonly fundedValue: string;
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
): DashboardJobPresentation {
  if (job.state === "orphaned") {
    return {
      fundedValue: formatCkbBalance(BigInt(job.funds.capacity)),
      nextAction: "Wait for canonical replay",
      nextEligibility: "Canonical status pending",
      status: "reorged",
    };
  }
  if (job.state === "spent") {
    return {
      fundedValue: formatCkbBalance(BigInt(job.funds.capacity)),
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
    fundedValue: formatCkbBalance(BigInt(job.funds.capacity)),
    nextAction,
    nextEligibility,
    status,
  };
}

export function dashboardSummary(items: readonly DashboardJob[]): DashboardSummary {
  const counts = { live: 0, orphaned: 0, spent: 0 };
  let funded = 0n;
  for (const item of items) {
    counts[item.state] += 1;
    funded += BigInt(item.funds.capacity);
  }
  return {
    fundedValue: formatCkbBalance(funded),
    ...counts,
    total: items.length,
  };
}

export function shortJobId(jobId: string): string {
  return jobId.length <= 22 ? jobId : `${jobId.slice(0, 10)}...${jobId.slice(-8)}`;
}
