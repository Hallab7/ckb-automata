import type { AutomataMetrics } from "./metrics.ts";
import type { TelemetryRuntime, TraceCarrier } from "./tracing.ts";

export const AUTOMATA_QUEUES = Object.freeze([
  "discovery",
  "evaluate",
  "build",
  "submit",
  "confirm",
  "notify",
  "dead-letter",
] as const);

export type AutomataQueue = (typeof AUTOMATA_QUEUES)[number];
export type QueueOperation = "enqueue" | "process";

export function createQueueTraceEnvelope(
  runtime: Pick<TelemetryRuntime, "inject">,
): Readonly<TraceCarrier> {
  return Object.freeze(runtime.inject({}));
}

export function traceQueueJob<T>(
  runtime: Pick<TelemetryRuntime, "extract" | "withSpan">,
  queue: AutomataQueue,
  operation: QueueOperation,
  carrier: Readonly<TraceCarrier>,
  work: () => Promise<T>,
): Promise<T> {
  return runtime.extract(carrier, () =>
    runtime.withSpan(
      `queue.${queue}.${operation}`,
      {
        "messaging.destination.name": queue,
        "messaging.operation.name": operation,
        "messaging.system": "bullmq",
      },
      work,
    ),
  );
}

export function recordQueueState(
  metrics: Pick<AutomataMetrics, "queueDepth" | "queueOldestSeconds">,
  queue: AutomataQueue,
  depth: number,
  oldestSeconds: number,
): void {
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new RangeError("queue depth must be a non-negative integer");
  }
  if (!Number.isFinite(oldestSeconds) || oldestSeconds < 0) {
    throw new RangeError("oldest queue age must be a non-negative number");
  }
  metrics.queueDepth.set({ queue }, depth);
  metrics.queueOldestSeconds.set({ queue }, oldestSeconds);
}
