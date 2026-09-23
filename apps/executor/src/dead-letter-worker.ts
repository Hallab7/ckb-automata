import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Worker, type Job } from "bullmq";

import { PostgresDeadLetterStore } from "./dead-letter-store.ts";
import { parseDeadLetterPayload } from "./dead-letter.ts";
import {
  DEFAULT_QUEUE_PREFIX,
  parseRedisConnection,
  type DeadLetterPayload,
  type QueueJobEnvelope,
} from "./queues.ts";
import type { ExecutorEventLogger, ExecutorRuntime } from "./runtime.ts";

function payload(job: Job<QueueJobEnvelope<DeadLetterPayload>>): DeadLetterPayload {
  if (job.name !== "terminal-failure" || job.data.schemaVersion !== 1) {
    throw new TypeError("dead-letter queue envelope is invalid");
  }
  return parseDeadLetterPayload(job.data.payload);
}

export class DeadLetterCoordinator implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #runtime: ExecutorRuntime;
  readonly #store: PostgresDeadLetterStore;
  readonly #redisUrl: string;
  readonly #prefix: string;
  readonly #logger: ExecutorEventLogger;
  #worker: Worker<QueueJobEnvelope<DeadLetterPayload>, unknown, string> | undefined;

  constructor(options: {
    readonly runtime: ExecutorRuntime;
    readonly store: PostgresDeadLetterStore;
    readonly redisUrl: string;
    readonly prefix?: string;
    readonly logger: ExecutorEventLogger;
  }) {
    this.#runtime = options.runtime;
    this.#store = options.store;
    this.#redisUrl = options.redisUrl;
    this.#prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
    this.#logger = options.logger;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.#worker = new Worker<QueueJobEnvelope<DeadLetterPayload>, unknown, string>(
      "dead-letter",
      (job) => this.#runtime.run(() => this.#store.persist(payload(job))),
      { connection: parseRedisConnection(this.#redisUrl), prefix: this.#prefix },
    );
    await this.#worker.waitUntilReady();
    this.#logger.info("executor.dead_letter.started", "Dead-letter persistence worker is ready");
  }

  async onModuleDestroy(): Promise<void> {
    await this.#worker?.close();
    this.#worker = undefined;
    await this.#store.closeConnection();
    this.#logger.info("executor.dead_letter.stopped", "Dead-letter persistence worker stopped");
  }
}
