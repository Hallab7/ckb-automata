import type { ApiJob, ApiJobEvents } from "@ckb-automata/api-client";

import { formatCkbBalance } from "../ccc/wallet-display.ts";

export type DetailJob = ApiJob;
export type DetailEvent = ApiJobEvents["items"][number];

export type JobDetailStatus =
  | "cancelled"
  | "completed"
  | "conflicted"
  | "dropped"
  | "eligible"
  | "needs_funding"
  | "recovery_required"
  | "reorged"
  | "unsupported"
  | "waiting";

export interface JobDetailPresentation {
  readonly status: JobDetailStatus;
  readonly statusLabel: string;
  readonly nextAction: string;
  readonly nextExecution: string;
  readonly policyName: string;
  readonly recipientAmount: string;
  readonly automationReserve: string;
  readonly remainingBudget: string;
  readonly executorReward: string;
}

const terminalEventStatus: Readonly<Record<string, JobDetailStatus | undefined>> = {
  job_cancelled: "cancelled",
  transaction_cancelled: "cancelled",
  transaction_conflicted: "conflicted",
  transaction_dropped: "dropped",
  transaction_reorged: "reorged",
};

function latestAttemptStatus(events: readonly DetailEvent[]): JobDetailStatus | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const eventStatus = terminalEventStatus[event.eventType];
    if (eventStatus !== undefined) return eventStatus;
    const state = event.attempt?.state;
    if (
      state === "cancelled" ||
      state === "conflicted" ||
      state === "dropped" ||
      state === "reorged"
    ) {
      return state;
    }
    if (event.attempt !== null) return undefined;
  }
  return undefined;
}

function blockLabel(value: bigint): string {
  return `Block #${value.toLocaleString("en-US")}`;
}

export function jobDetailPresentation(
  job: DetailJob,
  events: readonly DetailEvent[],
  recipientAmount?: string,
): JobDetailPresentation {
  const checkpoint = job.source.indexCheckpoint?.blockNumber;
  const checkpointBlock = checkpoint === undefined ? undefined : BigInt(checkpoint);
  const notBefore = BigInt(job.trigger.notBefore);
  const notAfter = BigInt(job.trigger.notAfter);
  const remainingBudget = BigInt(job.funds.remainingBudget);
  const reward = BigInt(job.funds.executorReward);
  const unsupported =
    job.protocol.version !== 1 || !["deadline", "recurring"].includes(job.template);
  const terminal = latestAttemptStatus(events);

  let status: JobDetailStatus;
  if (unsupported) status = "unsupported";
  else if (job.state === "orphaned" || events.at(-1)?.confidence === "reorged") {
    status = "reorged";
  } else if (terminal !== undefined) status = terminal;
  else if (job.state === "spent") status = "completed";
  else if (remainingBudget < reward) status = "needs_funding";
  else if (checkpointBlock !== undefined && notAfter !== 0n && checkpointBlock > notAfter) {
    status = "recovery_required";
  } else if (checkpointBlock !== undefined && checkpointBlock >= notBefore) status = "eligible";
  else status = "waiting";

  const statusLabels: Readonly<Record<JobDetailStatus, string>> = {
    cancelled: "Cancelled",
    completed: "Completed",
    conflicted: "Conflicted",
    dropped: "Dropped",
    eligible: "Eligible",
    needs_funding: "Needs funding",
    recovery_required: "Recovery required",
    reorged: "Reorged",
    unsupported: "Unsupported",
    waiting: "Waiting",
  };
  const nextActions: Readonly<Record<JobDetailStatus, string>> = {
    cancelled: "Funds returned by owner cancellation",
    completed: "Review the final canonical execution",
    conflicted: "Review the winning transaction and attempt receipt",
    dropped: "Review the dropped attempt before retrying",
    eligible: "Monitor permissionless executor attempts",
    needs_funding: "Top up the committed executor budget",
    recovery_required: "Recover the remaining live funds",
    reorged: "Wait for canonical replay before acting",
    unsupported: "Use owner recovery with the published manifest",
    waiting: "Wait for the committed schedule bound",
  };

  return Object.freeze({
    status,
    statusLabel: statusLabels[status],
    nextAction: nextActions[status],
    nextExecution:
      job.state !== "live"
        ? "No further scheduled execution"
        : checkpointBlock === undefined
          ? blockLabel(notBefore)
          : checkpointBlock >= notBefore
            ? `Eligible since ${blockLabel(notBefore)}`
            : `${blockLabel(notBefore)} (${(notBefore - checkpointBlock).toLocaleString("en-US")} blocks remaining)`,
    policyName:
      job.template === "deadline"
        ? "Deadline finalization"
        : job.template === "recurring"
          ? "Recurring distribution"
          : "Unknown policy",
    recipientAmount:
      recipientAmount === undefined ? "Unavailable" : formatCkbBalance(BigInt(recipientAmount)),
    automationReserve: formatCkbBalance(BigInt(job.funds.capacity)),
    remainingBudget: formatCkbBalance(remainingBudget),
    executorReward: formatCkbBalance(reward),
  });
}

export function eventLabel(eventType: string): string {
  return eventType
    .split("_")
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

export function mergeTimeline(
  current: readonly DetailEvent[],
  incoming: readonly DetailEvent[],
): readonly DetailEvent[] {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  return Object.freeze(
    [...byId.values()].toSorted((left, right) => {
      const leftId = BigInt(left.eventId);
      const rightId = BigInt(right.eventId);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    }),
  );
}
