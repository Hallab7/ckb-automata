import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Worker, type Job } from "bullmq";

import { parseBlockNumber, parseHash32, parseSequence } from "@ckb-automata/core";

import type { ExecutorAdapterRegistry, ExecutorIdentity } from "./adapter.ts";
import {
  TransactionBuildService,
  type BuildAttemptStore,
  type BuildSnapshotSource,
} from "./build.ts";
import type { BuildQueuePayload } from "./eligibility.ts";
import {
  DEFAULT_QUEUE_PREFIX,
  DurableQueueRegistry,
  forwardTerminalFailures,
  parseRedisConnection,
  type QueueJobEnvelope,
} from "./queues.ts";
import { executeWithRetryPolicy } from "./retry.ts";
import type { ExecutorEventLogger, ExecutorRuntime } from "./runtime.ts";

function payload(job: Job<QueueJobEnvelope<BuildQueuePayload>>): BuildQueuePayload {
  const value = job.data.payload;
  if (job.data.schemaVersion !== 1 || typeof value !== "object" || value === null) {
    throw new TypeError("build queue envelope is invalid");
  }
  return Object.freeze({
    jobId: parseHash32(value.jobId),
    sequence: parseSequence(value.sequence).toString(),
    adapterId: value.adapterId,
    evaluatedAt: Object.freeze({
      blockHash: parseHash32(value.evaluatedAt.blockHash),
      blockNumber: parseBlockNumber(value.evaluatedAt.blockNumber).toString(),
    }),
  });
}

export class BuildCoordinator implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #runtime: ExecutorRuntime;
  readonly #queues: DurableQueueRegistry;
  readonly #store: BuildAttemptStore & { close(): Promise<void> };
  readonly #source: BuildSnapshotSource;
  readonly #registry: ExecutorAdapterRegistry;
  readonly #identity: ExecutorIdentity;
  readonly #redisUrl: string;
  readonly #prefix: string;
  readonly #logger: ExecutorEventLogger;
  #worker: Worker<QueueJobEnvelope<BuildQueuePayload>, unknown, string> | undefined;

  constructor(options: {
    readonly runtime: ExecutorRuntime;
    readonly queues: DurableQueueRegistry;
    readonly store: BuildAttemptStore & { close(): Promise<void> };
    readonly source: BuildSnapshotSource;
    readonly registry: ExecutorAdapterRegistry;
    readonly identity: ExecutorIdentity;
    readonly redisUrl: string;
    readonly prefix?: string;
    readonly logger: ExecutorEventLogger;
  }) {
    this.#runtime = options.runtime;
    this.#queues = options.queues;
    this.#store = options.store;
    this.#source = options.source;
    this.#registry = options.registry;
    this.#identity = options.identity;
    this.#redisUrl = options.redisUrl;
    this.#prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
    this.#logger = options.logger;
  }

  async onApplicationBootstrap(): Promise<void> {
    const service = new TransactionBuildService({
      registry: this.#registry,
      identity: this.#identity,
      store: this.#store,
      source: this.#source,
      queues: this.#queues,
    });
    this.#worker = new Worker<QueueJobEnvelope<BuildQueuePayload>, unknown, string>(
      "build",
      (job) =>
        this.#runtime.run(() =>
          executeWithRetryPolicy(() => service.build(payload(job)), job.attemptsMade),
        ),
      {
        connection: parseRedisConnection(this.#redisUrl),
        prefix: this.#prefix,
      },
    );
    forwardTerminalFailures(this.#worker, "build", this.#queues, this.#logger);
    await this.#worker.waitUntilReady();
    this.#logger.info("executor.build.started", "Transaction build worker is ready");
  }

  async onModuleDestroy(): Promise<void> {
    await this.#worker?.close();
    this.#worker = undefined;
    await this.#store.close();
    this.#logger.info("executor.build.stopped", "Transaction build worker stopped");
  }
}
