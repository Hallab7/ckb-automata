import { createHash } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";

import type { Queue, Job, ConnectionOptions, JobsOptions, Worker } from "bullmq";

import {
  AUTOMATA_QUEUES,
  createQueueTraceEnvelope,
  type AutomataQueue,
  type TelemetryRuntime,
  type TraceCarrier,
} from "@ckb-automata/telemetry";

import { executorFailureCode } from "./retry.ts";

export const DEFAULT_QUEUE_PREFIX = "ckb-automata";
export const MAX_QUEUE_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;
export const QUEUE_READINESS_TIMEOUT_MS = 5_000;

export function executorQueuePrefix(instanceId?: string): string | undefined {
  if (instanceId === undefined) return undefined;
  const readable = `${DEFAULT_QUEUE_PREFIX}-${instanceId}`;
  if (/^[a-z][a-z0-9-]{2,47}$/.test(readable)) return readable;
  const normalized = instanceId.replaceAll("_", "-").slice(0, 22);
  const digest = createHash("sha256").update(instanceId).digest("hex").slice(0, 12);
  return `${DEFAULT_QUEUE_PREFIX}-${normalized}-${digest}`;
}

export interface QueuePolicy {
  readonly attempts: number;
  readonly backoff: Readonly<{
    readonly type: "exponential";
    readonly delay: number;
    readonly jitter: number;
  }>;
  readonly removeOnComplete: Readonly<{ readonly age: number; readonly count: number }>;
  readonly removeOnFail: Readonly<{ readonly age: number; readonly count: number }>;
}

const COMPLETE_RETENTION = Object.freeze({ age: 24 * 60 * 60, count: 1_000 });
const FAILURE_RETENTION = Object.freeze({ age: 7 * 24 * 60 * 60, count: 5_000 });

function policy(attempts: number, delay: number, jitter = 0.25): QueuePolicy {
  return Object.freeze({
    attempts,
    backoff: Object.freeze({ type: "exponential" as const, delay, jitter }),
    removeOnComplete: COMPLETE_RETENTION,
    removeOnFail: FAILURE_RETENTION,
  });
}

export const QUEUE_POLICIES = Object.freeze({
  discovery: policy(5, 1_000),
  evaluate: policy(8, 2_000),
  build: policy(3, 1_000),
  submit: policy(3, 2_000),
  confirm: policy(12, 5_000),
  notify: policy(5, 5_000),
  "dead-letter": policy(12, 2_000),
} satisfies Readonly<Record<AutomataQueue, QueuePolicy>>);

export interface QueueJobEnvelope<T = unknown> {
  readonly schemaVersion: 1;
  readonly trace: Readonly<TraceCarrier>;
  readonly payload: T;
}

export interface DeadLetterPayload {
  readonly sourceQueue: Exclude<AutomataQueue, "dead-letter">;
  readonly sourceJobId: string;
  readonly sourceOperation: string;
  readonly sourceEnvelope: QueueJobEnvelope<unknown>;
  readonly failureCode: string;
  readonly attempts: number;
  readonly failedAt: string;
}

interface DeadLetterEventLogger {
  error(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

function assertQueuePrefix(prefix: string): string {
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(prefix)) {
    throw new TypeError("queue prefix must be a lowercase deployment identifier");
  }
  return prefix;
}

export function parseRedisConnection(redisUrl: string): ConnectionOptions {
  const parsed = new URL(redisUrl);
  if (!["redis:", "rediss:"].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new TypeError("Redis connection must use a plain redis:// or rediss:// URL");
  }
  const databaseText = parsed.pathname.replace(/^\//, "");
  if (databaseText !== "" && !/^(0|[1-9][0-9]{0,2})$/.test(databaseText)) {
    throw new TypeError("Redis database must be a decimal index");
  }
  const database = databaseText === "" ? 0 : Number(databaseText);
  if (database > 255) throw new RangeError("Redis database index must not exceed 255");
  return Object.freeze({
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === "rediss:" ? 6380 : 6379)),
    db: database,
    maxRetriesPerRequest: null,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  });
}

export function queueRootOptions(redisUrl: string, prefix = DEFAULT_QUEUE_PREFIX) {
  return Object.freeze({
    connection: parseRedisConnection(redisUrl),
    prefix: assertQueuePrefix(prefix),
  });
}

export function queueRegistrationOptions(): readonly {
  readonly name: AutomataQueue;
  readonly defaultJobOptions: JobsOptions;
  readonly forceDisconnectOnShutdown: false;
}[] {
  return Object.freeze(
    AUTOMATA_QUEUES.map((name) =>
      Object.freeze({
        name,
        defaultJobOptions: QUEUE_POLICIES[name],
        forceDisconnectOnShutdown: false as const,
      }),
    ),
  );
}

export function stableQueueJobId(queue: AutomataQueue, idempotencyKey: string): string {
  const hasControlCharacter = [...idempotencyKey].some((character) => character.charCodeAt(0) < 32);
  if (idempotencyKey.length === 0 || idempotencyKey.length > 512 || hasControlCharacter) {
    throw new TypeError("queue idempotency key is invalid");
  }
  const digest = createHash("sha256")
    .update(queue)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex");
  return `automata-${queue}-${digest}`;
}

function assertOperation(value: string): string {
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(value)) {
    throw new TypeError("queue operation name is invalid");
  }
  return value;
}

function assertDelay(delay: number): number {
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_QUEUE_DELAY_MS) {
    throw new RangeError("queue delay is outside the supported range");
  }
  return delay;
}

export class DurableQueueRegistry {
  readonly #queues: ReadonlyMap<AutomataQueue, Queue>;
  readonly #readinessTimeoutMs: number;
  readonly #telemetry: Pick<TelemetryRuntime, "inject"> | undefined;

  constructor(
    queues: readonly Queue[],
    telemetry?: Pick<TelemetryRuntime, "inject">,
    options: { readonly readinessTimeoutMs?: number } = {},
  ) {
    const entries = queues.map((queue) => [queue.name, queue] as const);
    const names = new Set(entries.map(([name]) => name));
    if (
      entries.length !== AUTOMATA_QUEUES.length ||
      AUTOMATA_QUEUES.some((name) => !names.has(name))
    ) {
      throw new Error("durable queue registry requires each configured queue exactly once");
    }
    this.#queues = new Map(entries) as ReadonlyMap<AutomataQueue, Queue>;
    this.#telemetry = telemetry;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? QUEUE_READINESS_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#readinessTimeoutMs) || this.#readinessTimeoutMs < 1) {
      throw new RangeError("queue readiness timeout must be a positive integer");
    }
  }

  queue(name: AutomataQueue): Queue {
    const queue = this.#queues.get(name);
    if (!queue) throw new Error(`queue ${name} is not registered`);
    return queue;
  }

  async ready(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(AUTOMATA_QUEUES.map((name) => this.queue(name).waitUntilReady())),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Redis queue readiness timed out")),
            this.#readinessTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  enqueue<T>(
    queue: AutomataQueue,
    operation: string,
    idempotencyKey: string,
    payload: T,
    options: { readonly delay?: number } = {},
  ): Promise<Job<QueueJobEnvelope<T>>> {
    const trace = this.#telemetry ? createQueueTraceEnvelope(this.#telemetry) : Object.freeze({});
    return this.queue(queue).add(
      assertOperation(operation),
      Object.freeze({ schemaVersion: 1 as const, trace, payload }),
      {
        jobId: stableQueueJobId(queue, idempotencyKey),
        delay: assertDelay(options.delay ?? 0),
      },
    ) as Promise<Job<QueueJobEnvelope<T>>>;
  }

  deadLetter(
    sourceQueue: Exclude<AutomataQueue, "dead-letter">,
    sourceJob: Pick<Job<QueueJobEnvelope<unknown>>, "id" | "name" | "data" | "attemptsMade">,
    failureCode: string,
    failedAt = new Date(),
  ): Promise<Job<QueueJobEnvelope<DeadLetterPayload>>> {
    const sourceJobId = sourceJob.id;
    if (typeof sourceJobId !== "string" || !/^automata-[a-z-]+-[0-9a-f]{64}$/.test(sourceJobId)) {
      throw new TypeError("dead-letter source job ID is invalid");
    }
    assertOperation(sourceJob.name);
    if (
      sourceJob.data.schemaVersion !== 1 ||
      typeof sourceJob.data.trace !== "object" ||
      sourceJob.data.trace === null
    ) {
      throw new TypeError("dead-letter source envelope is invalid");
    }
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(failureCode)) {
      throw new TypeError("dead-letter failure code is invalid");
    }
    if (!Number.isSafeInteger(sourceJob.attemptsMade) || sourceJob.attemptsMade < 1) {
      throw new TypeError("dead-letter attempt count is invalid");
    }
    if (!Number.isFinite(failedAt.getTime()))
      throw new TypeError("dead-letter failure time is invalid");
    return this.enqueue(
      "dead-letter",
      "terminal-failure",
      `${sourceQueue}/${sourceJobId}/${failureCode}`,
      Object.freeze({
        sourceQueue,
        sourceJobId,
        sourceOperation: sourceJob.name,
        sourceEnvelope: sourceJob.data,
        failureCode,
        attempts: sourceJob.attemptsMade,
        failedAt: failedAt.toISOString(),
      }),
    );
  }
}

export function forwardTerminalFailures(
  worker: Pick<Worker, "on">,
  sourceQueue: Exclude<AutomataQueue, "dead-letter">,
  queues: DurableQueueRegistry,
  logger: DeadLetterEventLogger,
): void {
  worker.on("failed", (job, error) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? QUEUE_POLICIES[sourceQueue].attempts;
    const terminal = error.name === "UnrecoverableError" || job.attemptsMade >= attempts;
    if (!terminal) return;
    const failureCode = executorFailureCode(error) ?? "EXECUTOR_RETRY_EXHAUSTED";
    logger.error("executor.job.terminal_failure", "Executor queue job reached a terminal failure", {
      queue: sourceQueue,
      jobId: job.id,
      failureCode,
      attempts: job.attemptsMade,
      failureName: error.name,
      failureMessage: error.message.slice(0, 512),
    });
    void queues
      .deadLetter(sourceQueue, job as Job<QueueJobEnvelope<unknown>>, failureCode)
      .catch((forwardingError: unknown) => {
        logger.error("executor.dead_letter.forward_failed", "Dead-letter forwarding failed", {
          queue: sourceQueue,
          jobId: job.id,
          failureCode,
          forwardingError:
            forwardingError instanceof Error ? forwardingError.name : "UnknownFailure",
        });
      });
  });
}
