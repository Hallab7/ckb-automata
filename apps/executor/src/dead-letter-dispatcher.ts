import { clearTimeout, setTimeout } from "node:timers";

import { Queue, type Job, type QueueOptions } from "bullmq";

import type { AutomataQueue } from "@ckb-automata/telemetry";

import {
  enqueueQueueJob,
  QUEUE_READINESS_TIMEOUT_MS,
  queueRootOptions,
  type QueueEnqueuer,
  type QueueJobEnvelope,
} from "./queues.ts";

type ReplayQueue = Pick<Queue, "add" | "close" | "waitUntilReady">;
type ReplayQueueFactory = (name: AutomataQueue, options: QueueOptions) => ReplayQueue;

export class DeadLetterReplayDispatcher implements QueueEnqueuer {
  readonly #redisUrl: string | undefined;
  readonly #queuePrefix: string;
  readonly #createQueue: ReplayQueueFactory;
  readonly #readinessTimeoutMs: number;
  #queue: { readonly name: AutomataQueue; readonly value: ReplayQueue } | undefined;

  constructor(
    redisUrl: string | undefined,
    queuePrefix: string,
    createQueue: ReplayQueueFactory = (name, options) => new Queue(name, options),
    readinessTimeoutMs = QUEUE_READINESS_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1) {
      throw new RangeError("queue readiness timeout must be a positive integer");
    }
    this.#redisUrl = redisUrl;
    this.#queuePrefix = queuePrefix;
    this.#createQueue = createQueue;
    this.#readinessTimeoutMs = readinessTimeoutMs;
  }

  async enqueue<T>(
    queueName: AutomataQueue,
    operation: string,
    idempotencyKey: string,
    payload: T,
    options: { readonly delay?: number } = {},
  ): Promise<Job<QueueJobEnvelope<T>>> {
    if (!this.#redisUrl) throw new Error("REDIS_URL is required");
    if (this.#queue !== undefined && this.#queue.name !== queueName) {
      throw new Error("dead-letter replay dispatcher is limited to one source queue");
    }
    if (this.#queue === undefined) {
      this.#queue = Object.freeze({
        name: queueName,
        value: this.#createQueue(queueName, queueRootOptions(this.#redisUrl, this.#queuePrefix)),
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#queue.value.waitUntilReady(),
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
    return enqueueQueueJob(
      this.#queue.value,
      queueName,
      operation,
      idempotencyKey,
      payload,
      options,
    );
  }

  async close(): Promise<void> {
    await this.#queue?.value.close();
  }
}
