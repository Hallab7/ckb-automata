import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Worker, type Job } from "bullmq";

import { parseHash32 } from "@ckb-automata/core";

import {
  SimulationGateService,
  type SimulationQueuePayload,
  type SimulationStore,
} from "./simulation.ts";
import {
  DEFAULT_QUEUE_PREFIX,
  DurableQueueRegistry,
  forwardTerminalFailures,
  parseRedisConnection,
  type QueueJobEnvelope,
} from "./queues.ts";
import { executeWithRetryPolicy } from "./retry.ts";
import type { ExecutorEventLogger, ExecutorRuntime } from "./runtime.ts";
import type { SubmissionService, SubmissionStore } from "./submission.ts";

function payload(job: Job<QueueJobEnvelope<SimulationQueuePayload>>): SimulationQueuePayload {
  const value = job.data.payload;
  if (
    job.name !== "dry-run-transaction" ||
    job.data.schemaVersion !== 1 ||
    typeof value !== "object" ||
    value === null
  ) {
    throw new TypeError("simulation queue envelope is invalid");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.attemptId,
    )
  ) {
    throw new TypeError("simulation attempt ID is invalid");
  }
  return Object.freeze({
    attemptId: value.attemptId,
    intentHash: parseHash32(value.intentHash),
  });
}

export class SimulationCoordinator implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #runtime: ExecutorRuntime;
  readonly #queues: DurableQueueRegistry;
  readonly #store: SimulationStore & { close(): Promise<void> };
  readonly #service: SimulationGateService;
  readonly #submission: SubmissionService;
  readonly #submissionStore: SubmissionStore & { close(): Promise<void> };
  readonly #redisUrl: string;
  readonly #prefix: string;
  readonly #logger: ExecutorEventLogger;
  #worker: Worker<QueueJobEnvelope<SimulationQueuePayload>, unknown, string> | undefined;

  constructor(options: {
    readonly runtime: ExecutorRuntime;
    readonly queues: DurableQueueRegistry;
    readonly store: SimulationStore & { close(): Promise<void> };
    readonly service: SimulationGateService;
    readonly submission: SubmissionService;
    readonly submissionStore: SubmissionStore & { close(): Promise<void> };
    readonly redisUrl: string;
    readonly prefix?: string;
    readonly logger: ExecutorEventLogger;
  }) {
    this.#runtime = options.runtime;
    this.#queues = options.queues;
    this.#store = options.store;
    this.#service = options.service;
    this.#submission = options.submission;
    this.#submissionStore = options.submissionStore;
    this.#redisUrl = options.redisUrl;
    this.#prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
    this.#logger = options.logger;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.#worker = new Worker<QueueJobEnvelope<SimulationQueuePayload>, unknown, string>(
      "submit",
      (job) =>
        this.#runtime.run(() =>
          executeWithRetryPolicy(async () => {
            const canonicalPayload = payload(job);
            const simulation = await this.#service.evaluate(canonicalPayload);
            if (simulation.status === "rejected") return simulation;
            return this.#submission.submit(canonicalPayload);
          }, job.attemptsMade),
        ),
      {
        connection: parseRedisConnection(this.#redisUrl),
        prefix: this.#prefix,
      },
    );
    forwardTerminalFailures(this.#worker, "submit", this.#queues, this.#logger);
    await this.#worker.waitUntilReady();
    this.#logger.info("executor.simulation.started", "Dry-run and profitability worker is ready");
  }

  async onModuleDestroy(): Promise<void> {
    await this.#worker?.close();
    this.#worker = undefined;
    await Promise.all([this.#store.close(), this.#submissionStore.close()]);
    this.#logger.info("executor.simulation.stopped", "Dry-run and profitability worker stopped");
  }
}
