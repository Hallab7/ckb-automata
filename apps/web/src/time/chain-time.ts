const TARGET_BLOCK_MILLISECONDS = 10_000n;

function parsedDate(value: string): Date | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

export function estimateBlockDate(
  targetBlock: string | bigint,
  checkpointBlock: string | bigint,
  checkpointAt: string,
): Date | undefined {
  const checkpointDate = parsedDate(checkpointAt);
  if (checkpointDate === undefined) return undefined;

  try {
    const deltaMilliseconds =
      (BigInt(targetBlock) - BigInt(checkpointBlock)) * TARGET_BLOCK_MILLISECONDS;
    const timestamp = BigInt(checkpointDate.getTime()) + deltaMilliseconds;
    const numericTimestamp = Number(timestamp);
    if (!Number.isSafeInteger(numericTimestamp)) return undefined;
    const estimated = new Date(numericTimestamp);
    return Number.isNaN(estimated.getTime()) ? undefined : estimated;
  } catch {
    return undefined;
  }
}

export function formatDateTime(value: string | Date): string {
  const date = typeof value === "string" ? parsedDate(value) : value;
  if (date === undefined || Number.isNaN(date.getTime())) return "Time unavailable";
  const formatted = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
  return `${formatted} UTC`;
}

export function formatBlockDate(
  targetBlock: string | bigint,
  checkpointBlock: string | bigint,
  checkpointAt: string,
): string {
  const date = estimateBlockDate(targetBlock, checkpointBlock, checkpointAt);
  return date === undefined ? "Schedule time unavailable" : formatDateTime(date);
}

export function calendarDateParts(value: string | Date | undefined): {
  readonly day: string;
  readonly month: string;
} {
  const date =
    value === undefined ? undefined : typeof value === "string" ? parsedDate(value) : value;
  if (date === undefined || Number.isNaN(date.getTime())) return { day: "--", month: "---" };
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).formatToParts(date);
  return {
    day: parts.find((part) => part.type === "day")?.value ?? "--",
    month: parts.find((part) => part.type === "month")?.value.toUpperCase() ?? "---",
  };
}

export function formatBlockDuration(blocks: bigint): string {
  if (blocks <= 0n) return "Now";
  const totalMinutes = (blocks * 10n + 59n) / 60n;
  if (totalMinutes < 60n) return `${totalMinutes} min`;
  const hours = (totalMinutes + 59n) / 60n;
  if (hours < 24n) return `${hours} hr`;
  const days = (hours + 23n) / 24n;
  return `${days} day${days === 1n ? "" : "s"}`;
}
