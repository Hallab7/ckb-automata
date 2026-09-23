import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import postgres from "postgres";

import type { AutomataEnvironment } from "@ckb-automata/config";
import {
  deploymentRegistry,
  parseBlockNumber,
  parseHash32,
  parseSequence,
  type RegisteredDeployment,
} from "@ckb-automata/core";

import type { ExecutorAdapterRegistry, ExecutorHeaderSnapshot } from "./adapter.ts";
import {
  EligibilityEvaluator,
  type EligibilityJobRecord,
  type EligibilityQueuePayload,
} from "./eligibility.ts";
import {
  DEFAULT_QUEUE_PREFIX,
  DurableQueueRegistry,
  forwardTerminalFailures,
  parseRedisConnection,
  type QueueJobEnvelope,
} from "./queues.ts";
import { executeWithRetryPolicy } from "./retry.ts";
import type { ExecutorEventLogger, ExecutorRuntime } from "./runtime.ts";

export const DISCOVERY_INTERVAL_MS = 5_000;
export const MAX_DISCOVERY_JOBS = 500;

export interface EligibilityRow {
  readonly network_id: string;
  readonly job_id: string;
  readonly sequence: string;
  readonly policy_kind: string;
  readonly data: Buffer;
  readonly capacity: string;
  readonly outpoint_tx_hash: string;
  readonly outpoint_index: string;
  readonly block_hash: string;
  readonly block_number: string;
}

export interface EligibilityJobSource {
  listLiveJobs(options?: {
    readonly afterJobId?: string;
    readonly limit?: number;
  }): Promise<readonly EligibilityJobRecord[]>;
  getLiveJob(jobId: string, sequence: string): Promise<EligibilityJobRecord | undefined>;
  close(): Promise<void>;
}

export function eligibilityRecordFromRow(row: EligibilityRow): EligibilityJobRecord {
  if (row.policy_kind !== "deadline" && row.policy_kind !== "recurring") {
    throw new Error("live job has an unsupported policy kind");
  }
  return Object.freeze({
    networkId: row.network_id,
    jobId: parseHash32(row.job_id),
    sequence: parseSequence(row.sequence).toString(),
    policyKind: row.policy_kind,
    data: `0x${row.data.toString("hex")}`,
    capacity: row.capacity,
    outPoint: Object.freeze({
      txHash: parseHash32(row.outpoint_tx_hash),
      index: row.outpoint_index,
    }),
    block: Object.freeze({
      hash: parseHash32(row.block_hash),
      number: parseBlockNumber(row.block_number).toString(),
    }),
  });
}

export class PostgresEligibilityJobSource implements EligibilityJobSource {
  readonly #network: string;
  readonly #sql: postgres.Sql;
  #closed = false;

  constructor(connectionString: string, network: string) {
    const url = new URL(connectionString);
    if (url.protocol !== "postgresql:") {
      throw new TypeError("eligibility database must use postgresql://");
    }
    this.#network = network;
    this.#sql = postgres(connectionString, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: 2,
      onnotice: () => undefined,
    });
  }

  async listLiveJobs(
    options: { readonly afterJobId?: string; readonly limit?: number } = {},
  ): Promise<readonly EligibilityJobRecord[]> {
    const limit = options.limit ?? MAX_DISCOVERY_JOBS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_JOBS) {
      throw new RangeError(
        `eligibility discovery limit must be between 1 and ${MAX_DISCOVERY_JOBS}`,
      );
    }
    const afterJobId =
      options.afterJobId === undefined ? undefined : parseHash32(options.afterJobId);
    const rows =
      afterJobId === undefined
        ? await this.#sql<EligibilityRow[]>`
            SELECT network_id, job_id, sequence, policy_kind, data, capacity,
                   outpoint_tx_hash, outpoint_index, block_hash, block_number
            FROM jobs
            WHERE network_id = ${this.#network} AND state = 'live'
            ORDER BY job_id
            LIMIT ${limit}
          `
        : await this.#sql<EligibilityRow[]>`
            SELECT network_id, job_id, sequence, policy_kind, data, capacity,
                   outpoint_tx_hash, outpoint_index, block_hash, block_number
            FROM jobs
            WHERE network_id = ${this.#network}
              AND state = 'live'
              AND job_id > ${afterJobId}
            ORDER BY job_id
            LIMIT ${limit}
          `;
    return Object.freeze(rows.map(eligibilityRecordFromRow));
  }

  async getLiveJob(jobId: string, sequence: string): Promise<EligibilityJobRecord | undefined> {
    const canonicalJobId = parseHash32(jobId);
    const canonicalSequence = parseSequence(sequence).toString();
    const rows = await this.#sql<EligibilityRow[]>`
      SELECT network_id, job_id, sequence, policy_kind, data, capacity,
             outpoint_tx_hash, outpoint_index, block_hash, block_number
      FROM jobs
      WHERE network_id = ${this.#network}
        AND job_id = ${canonicalJobId}
        AND sequence = ${canonicalSequence}
        AND state = 'live'
      LIMIT 1
    `;
    return rows[0] ? eligibilityRecordFromRow(rows[0]) : undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sql.end({ timeout: 5 });
  }
}

interface DiscoveryPayload {
  readonly slot: number;
}

function queuePayload<T>(job: Job<QueueJobEnvelope<T>>): T {
  if (
    job.data.schemaVersion !== 1 ||
    typeof job.data.payload !== "object" ||
    job.data.payload === null
  ) {
    throw new TypeError("queue job envelope is invalid");
  }
  return job.data.payload;
}

function eligibilityPayload(job: Job<QueueJobEnvelope<EligibilityQueuePayload>>) {
  const payload = queuePayload(job);
  if (!Number.isSafeInteger(payload.wakeSequence) || payload.wakeSequence < 0) {
    throw new TypeError("eligibility wake sequence is invalid");
  }
  return Object.freeze({
    jobId: parseHash32(payload.jobId),
    sequence: parseSequence(payload.sequence).toString(),
    wakeSequence: payload.wakeSequence,
  });
}

function discoveryPayload(job: Job<QueueJobEnvelope<DiscoveryPayload>>): DiscoveryPayload {
  const payload = queuePayload(job);
  if (!Number.isSafeInteger(payload.slot) || payload.slot < 0) {
    throw new TypeError("discovery slot is invalid");
  }
  return payload;
}

function nextSlot(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("discovery clock is invalid");
  return Math.floor(now / DISCOVERY_INTERVAL_MS) + 1;
}

function headerSnapshot(
  header: Awaited<ReturnType<ExecutorRuntime["getTipHeader"]>>,
): ExecutorHeaderSnapshot {
  return Object.freeze({
    hash: parseHash32(header.hash),
    number: parseBlockNumber(header.number.toString()),
    epoch: header.epoch.toString() as `0x${string}`,
    timestamp: header.timestamp.toString() as `0x${string}`,
  });
}

export class EligibilityCoordinator implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #environment: AutomataEnvironment;
  readonly #runtime: ExecutorRuntime;
  readonly #registry: ExecutorAdapterRegistry;
  readonly #queues: DurableQueueRegistry;
  readonly #source: EligibilityJobSource;
  readonly #logger: ExecutorEventLogger;
  readonly #prefix: string;
  readonly #now: () => number;
  #deployment: RegisteredDeployment | undefined;
  #workers: Worker[] = [];

  constructor(options: {
    readonly environment: AutomataEnvironment;
    readonly runtime: ExecutorRuntime;
    readonly registry: ExecutorAdapterRegistry;
    readonly queues: DurableQueueRegistry;
    readonly source: EligibilityJobSource;
    readonly logger: ExecutorEventLogger;
    readonly prefix?: string;
    readonly now?: () => number;
  }) {
    this.#environment = options.environment;
    this.#runtime = options.runtime;
    this.#registry = options.registry;
    this.#queues = options.queues;
    this.#source = options.source;
    this.#logger = options.logger;
    this.#prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
    this.#now = options.now ?? Date.now;
  }

  async onApplicationBootstrap(): Promise<void> {
    const loaded = await deploymentRegistry.load(this.#environment.CKB_GENESIS_HASH);
    if (loaded.status !== "ok" || loaded.deployment.network !== this.#environment.CKB_NETWORK) {
      throw new Error("executor deployment is unavailable for eligibility evaluation");
    }
    this.#deployment = loaded.deployment;
    const workerOptions = {
      connection: parseRedisConnection(this.#environment.REDIS_URL),
      prefix: this.#prefix,
    };
    this.#workers = [
      new Worker<QueueJobEnvelope<DiscoveryPayload>, unknown, string>(
        "discovery",
        (job) =>
          this.#runtime.run(() =>
            executeWithRetryPolicy(() => this.#discover(job), job.attemptsMade),
          ),
        workerOptions,
      ),
      new Worker<QueueJobEnvelope<EligibilityQueuePayload>, unknown, string>(
        "evaluate",
        (job) =>
          this.#runtime.run(() =>
            executeWithRetryPolicy(() => this.#evaluate(job), job.attemptsMade),
          ),
        workerOptions,
      ),
    ];
    forwardTerminalFailures(this.#workers[0]!, "discovery", this.#queues, this.#logger);
    forwardTerminalFailures(this.#workers[1]!, "evaluate", this.#queues, this.#logger);
    await Promise.all(this.#workers.map((worker) => worker.waitUntilReady()));
    await this.#runtime.run(() => this.#scanAndSchedule(nextSlot(this.#now())));
    this.#logger.info("executor.eligibility.started", "Eligibility workers are ready");
  }

  async #discover(job: Job<QueueJobEnvelope<DiscoveryPayload>>): Promise<{ discovered: number }> {
    const payload = discoveryPayload(job);
    return this.#scanAndSchedule(Math.max(payload.slot + 1, nextSlot(this.#now())));
  }

  async #scanAndSchedule(slot: number): Promise<{ discovered: number }> {
    const evaluator = this.#evaluator();
    let discovered = 0;
    let afterJobId: string | undefined;
    for (;;) {
      const records = await this.#source.listLiveJobs({
        ...(afterJobId === undefined ? {} : { afterJobId }),
        limit: MAX_DISCOVERY_JOBS,
      });
      discovered += await evaluator.enqueueLiveJobs(records);
      if (records.length < MAX_DISCOVERY_JOBS) break;
      afterJobId = records.at(-1)?.jobId;
      if (afterJobId === undefined) break;
    }
    const delay = Math.max(0, slot * DISCOVERY_INTERVAL_MS - this.#now());
    await this.#queues.enqueue(
      "discovery",
      "scan-live-jobs",
      `slot-${slot}`,
      Object.freeze({ slot }),
      { delay },
    );
    return Object.freeze({ discovered });
  }

  async #evaluate(
    job: Job<QueueJobEnvelope<EligibilityQueuePayload>>,
  ): Promise<{ status: string }> {
    const payload = eligibilityPayload(job);
    const record = await this.#source.getLiveJob(payload.jobId, payload.sequence);
    if (!record) return Object.freeze({ status: "stale" });
    const tip = headerSnapshot(await this.#runtime.getTipHeader());
    const result = await this.#evaluator().evaluate(record, tip, payload.wakeSequence);
    return Object.freeze({ status: result.status });
  }

  #evaluator(): EligibilityEvaluator {
    if (!this.#deployment) throw new Error("eligibility coordinator is not initialized");
    return new EligibilityEvaluator(this.#deployment, this.#registry, this.#queues);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.#workers.map((worker) => worker.close()));
    this.#workers = [];
    await this.#source.close();
    this.#logger.info("executor.eligibility.stopped", "Eligibility workers stopped");
  }
}
