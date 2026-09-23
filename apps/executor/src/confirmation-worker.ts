import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Worker, type Job } from "bullmq";

import { parseHash32 } from "@ckb-automata/core";

import {
  ConfirmationService,
  type ConfirmationQueuePayload,
  type ConfirmationStore,
} from "./confirmation.ts";
import { MAX_CONFIRMATION_ATTEMPTS } from "./confirmation-store.ts";
import {
  DEFAULT_QUEUE_PREFIX,
  DurableQueueRegistry,
  forwardTerminalFailures,
  parseRedisConnection,
  type QueueJobEnvelope,
} from "./queues.ts";
import { executeWithRetryPolicy } from "./retry.ts";
import type { ExecutorEventLogger, ExecutorRuntime } from "./runtime.ts";

export const CONFIRMATION_POLL_MS = 5_000;

interface ScanPayload {
  readonly slot: number;
}

function confirmationPayload(
  job: Job<QueueJobEnvelope<ConfirmationQueuePayload>>,
): ConfirmationQueuePayload {
  const value = job.data.payload;
  if (
    job.name !== "track-transaction" ||
    job.data.schemaVersion !== 1 ||
    typeof value !== "object" ||
    value === null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.attemptId,
    )
  ) {
    throw new TypeError("confirmation queue envelope is invalid");
  }
  return Object.freeze({
    attemptId: value.attemptId,
    transactionHash: parseHash32(value.transactionHash),
  });
}

function scanPayload(job: Job<QueueJobEnvelope<ScanPayload>>): ScanPayload {
  const value = job.data.payload;
  if (
    job.name !== "scan-confirmations" ||
    job.data.schemaVersion !== 1 ||
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < 0
  ) {
    throw new TypeError("confirmation scan envelope is invalid");
  }
  return value;
}

function nextSlot(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("confirmation clock is invalid");
  return Math.floor(now / CONFIRMATION_POLL_MS) + 1;
}

export class ConfirmationCoordinator implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #runtime: ExecutorRuntime;
  readonly #queues: DurableQueueRegistry;
  readonly #store: ConfirmationStore & { close(): Promise<void> };
  readonly #service: ConfirmationService;
  readonly #redisUrl: string;
  readonly #prefix: string;
  readonly #logger: ExecutorEventLogger;
  readonly #now: () => number;
  #worker: Worker | undefined;

  constructor(options: {
    readonly runtime: ExecutorRuntime;
    readonly queues: DurableQueueRegistry;
    readonly store: ConfirmationStore & { close(): Promise<void> };
    readonly service: ConfirmationService;
    readonly redisUrl: string;
    readonly prefix?: string;
    readonly logger: ExecutorEventLogger;
    readonly now?: () => number;
  }) {
    this.#runtime = options.runtime;
    this.#queues = options.queues;
    this.#store = options.store;
    this.#service = options.service;
    this.#redisUrl = options.redisUrl;
    this.#prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.#worker = new Worker<
      QueueJobEnvelope<ConfirmationQueuePayload | ScanPayload>,
      unknown,
      string
    >(
      "confirm",
      (job) =>
        this.#runtime.run(() =>
          executeWithRetryPolicy(async () => {
            if (job.name === "scan-confirmations") {
              const scan = scanPayload(job as Job<QueueJobEnvelope<ScanPayload>>);
              return this.#scanAndSchedule(Math.max(scan.slot + 1, nextSlot(this.#now())));
            }
            return this.#service.track(
              confirmationPayload(job as Job<QueueJobEnvelope<ConfirmationQueuePayload>>),
            );
          }, job.attemptsMade),
        ),
      { connection: parseRedisConnection(this.#redisUrl), prefix: this.#prefix },
    );
    forwardTerminalFailures(this.#worker, "confirm", this.#queues, this.#logger);
    await this.#worker.waitUntilReady();
    await this.#runtime.run(() => this.#scanAndSchedule(nextSlot(this.#now())));
    this.#logger.info("executor.confirmation.started", "Confirmation worker is ready");
  }

  async #scanAndSchedule(slot: number): Promise<{ tracked: number }> {
    let tracked = 0;
    let afterAttemptId: string | undefined;
    for (;;) {
      const attempts = await this.#store.listPending({
        ...(afterAttemptId === undefined ? {} : { afterAttemptId }),
        limit: MAX_CONFIRMATION_ATTEMPTS,
      });
      await Promise.all(
        attempts.map((attempt) =>
          this.#queues.enqueue(
            "confirm",
            "track-transaction",
            `${attempt.attemptId}/${attempt.transactionHash}/slot-${slot}`,
            attempt,
          ),
        ),
      );
      tracked += attempts.length;
      if (attempts.length < MAX_CONFIRMATION_ATTEMPTS) break;
      afterAttemptId = attempts.at(-1)?.attemptId;
      if (afterAttemptId === undefined) break;
    }
    const delay = Math.max(0, slot * CONFIRMATION_POLL_MS - this.#now());
    await this.#queues.enqueue(
      "confirm",
      "scan-confirmations",
      `slot-${slot}`,
      Object.freeze({ slot }),
      { delay },
    );
    return Object.freeze({ tracked });
  }

  async onModuleDestroy(): Promise<void> {
    await this.#worker?.close();
    this.#worker = undefined;
    await this.#store.close();
    this.#logger.info("executor.confirmation.stopped", "Confirmation worker stopped");
  }
}
