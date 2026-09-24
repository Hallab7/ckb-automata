import type { ApiActivity } from "@ckb-automata/api-client";

export type ActivityEvent = ApiActivity["items"][number];
export type ActivityOutcomeFilter =
  "" | "submitted" | "confirmed" | "conflicted" | "dropped" | "reorged" | "cancelled" | "recovery";

export interface ActivityGroup {
  readonly items: readonly ActivityEvent[];
  readonly jobId: string;
}

export function activityOutcome(event: ActivityEvent): string {
  if (event.attempt !== null) return event.attempt.state;
  if (event.eventType.includes("recover")) return "recovery";
  if (event.eventType.includes("cancel")) return "cancelled";
  return event.eventType.replace(/^transaction_/, "").replace(/^execution_/, "");
}

export function activityLabel(event: ActivityEvent): string {
  return event.eventType
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function filterActivity(
  items: readonly ActivityEvent[],
  outcome: ActivityOutcomeFilter,
): readonly ActivityEvent[] {
  if (outcome === "") return items;
  return items.filter((event) => {
    const value = activityOutcome(event);
    if (outcome === "recovery")
      return value.includes("recover") || event.eventType.includes("recover");
    return value === outcome;
  });
}

export function groupActivity(items: readonly ActivityEvent[]): readonly ActivityGroup[] {
  const groups = new Map<string, ActivityEvent[]>();
  for (const item of items) {
    const group = groups.get(item.jobId);
    if (group === undefined) groups.set(item.jobId, [item]);
    else group.push(item);
  }
  return Object.freeze(
    [...groups].map(([jobId, groupItems]) =>
      Object.freeze({ jobId, items: Object.freeze(groupItems) }),
    ),
  );
}

export function mergeActivity(
  current: readonly ActivityEvent[],
  incoming: readonly ActivityEvent[],
): readonly ActivityEvent[] {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  return Object.freeze(
    [...byId.values()].toSorted((left, right) => {
      const leftId = BigInt(left.eventId);
      const rightId = BigInt(right.eventId);
      return leftId > rightId ? -1 : leftId < rightId ? 1 : 0;
    }),
  );
}
