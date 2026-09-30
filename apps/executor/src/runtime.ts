import { clearInterval, setInterval } from "node:timers";

import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";

import type { CkbClient } from "@ckb-automata/ccc";
import type { AutomataEnvironment } from "@ckb-automata/config";

import type { ExecutorAdapterRegistry } from "./adapter.ts";

export type ExecutorRuntimeState =
  "starting" | "ready" | "paused" | "not_ready" | "draining" | "stopped";

export interface ExecutorReadinessReport {
  readonly status: ExecutorRuntimeState;
  readonly instanceId: string;
  readonly network: string;
  readonly activeWork: number;
  readonly adapters: readonly string[];
  readonly chain: {
    readonly status: "pending" | "up" | "down" | "closed";
    readonly genesisHash?: string;
  };
  readonly redis: {
    readonly status: "pending" | "up" | "down";
  };
}

export type ExecutorChainClient = Pick<
  CkbClient,
  | "close"
  | "dryRun"
  | "findCellsPaged"
  | "getCellLive"
  | "getBlockByHash"
  | "getBlockByNumber"
  | "getGenesisHash"
  | "getTipHeader"
  | "getTransactionStatus"
  | "send"
>;

export interface ExecutorQueueReadiness {
  ready(): Promise<void>;
}

export interface ExecutorEventLogger {
  info(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export class ExecutorRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #environment: AutomataEnvironment;
  readonly #chain: ExecutorChainClient;
  readonly #registry: ExecutorAdapterRegistry;
  readonly #queues: ExecutorQueueReadiness;
  readonly #adapterIds: readonly string[];
  readonly #logger: ExecutorEventLogger;
  readonly #idleWaiters = new Set<() => void>();
  #activeWork = 0;
  #chainStatus: ExecutorReadinessReport["chain"]["status"] = "pending";
  #genesisHash: string | undefined;
  #lifetimeHandle: ReturnType<typeof setInterval> | undefined;
  #redisStatus: ExecutorReadinessReport["redis"]["status"] = "pending";
  #state: ExecutorRuntimeState = "starting";

  constructor(options: {
    readonly environment: AutomataEnvironment;
    readonly chain: ExecutorChainClient;
    readonly registry: ExecutorAdapterRegistry;
    readonly queues: ExecutorQueueReadiness;
    readonly adapterIds: readonly string[];
    readonly logger: ExecutorEventLogger;
  }) {
    this.#environment = options.environment;
    this.#chain = options.chain;
    this.#registry = options.registry;
    this.#queues = options.queues;
    this.#adapterIds = Object.freeze([...options.adapterIds]);
    this.#logger = options.logger;
  }

  get registry(): ExecutorAdapterRegistry {
    return this.#registry;
  }

  #assertChainAvailable(): void {
    if (this.#state !== "ready" && this.#state !== "paused") {
      throw new Error("executor chain reads require ready or paused state");
    }
  }

  getTipHeader(): ReturnType<ExecutorChainClient["getTipHeader"]> {
    this.#assertChainAvailable();
    return this.#chain.getTipHeader();
  }

  dryRun(...args: Parameters<ExecutorChainClient["dryRun"]>) {
    this.#assertChainAvailable();
    return this.#chain.dryRun(...args);
  }

  getCellLive(...args: Parameters<ExecutorChainClient["getCellLive"]>) {
    this.#assertChainAvailable();
    return this.#chain.getCellLive(...args);
  }

  getBlockByHash(...args: Parameters<ExecutorChainClient["getBlockByHash"]>) {
    this.#assertChainAvailable();
    return this.#chain.getBlockByHash(...args);
  }

  getBlockByNumber(...args: Parameters<ExecutorChainClient["getBlockByNumber"]>) {
    this.#assertChainAvailable();
    return this.#chain.getBlockByNumber(...args);
  }

  findCellsPaged(...args: Parameters<ExecutorChainClient["findCellsPaged"]>) {
    this.#assertChainAvailable();
    return this.#chain.findCellsPaged(...args);
  }

  getTransactionStatus(...args: Parameters<ExecutorChainClient["getTransactionStatus"]>) {
    this.#assertChainAvailable();
    return this.#chain.getTransactionStatus(...args);
  }

  send(...args: Parameters<ExecutorChainClient["send"]>) {
    this.#assertChainAvailable();
    return this.#chain.send(...args);
  }

  readiness(): ExecutorReadinessReport {
    return Object.freeze({
      status: this.#state,
      instanceId: this.#environment.EXECUTOR_INSTANCE_ID ?? "executor-local",
      network: this.#environment.CKB_NETWORK,
      activeWork: this.#activeWork,
      adapters: this.#adapterIds,
      chain: Object.freeze({
        status: this.#chainStatus,
        ...(this.#genesisHash === undefined ? {} : { genesisHash: this.#genesisHash }),
      }),
      redis: Object.freeze({ status: this.#redisStatus }),
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      const genesisHash = await this.#chain.getGenesisHash();
      if (genesisHash.toLowerCase() !== this.#environment.CKB_GENESIS_HASH.toLowerCase()) {
        throw new Error("executor CKB client is connected to the wrong network");
      }
      this.#genesisHash = genesisHash;
      this.#chainStatus = "up";
      await this.#queues.ready();
      this.#redisStatus = "up";
      this.#state = "ready";
      this.#lifetimeHandle = setInterval(() => undefined, 60_000);
      this.#logger.info("executor.ready", "Executor is ready", {
        adapters: this.#adapterIds,
        instanceId: this.#environment.EXECUTOR_INSTANCE_ID ?? "executor-local",
        network: this.#environment.CKB_NETWORK,
      });
    } catch (error) {
      if (this.#chainStatus === "pending") this.#chainStatus = "down";
      else this.#redisStatus = "down";
      this.#state = "not_ready";
      this.#logger.error("executor.readiness.failed", "Executor readiness check failed");
      await this.#chain.close();
      this.#chainStatus = "closed";
      throw error;
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#state !== "ready") {
      throw new Error("executor is not accepting work");
    }
    this.#activeWork += 1;
    try {
      return await operation();
    } finally {
      this.#activeWork -= 1;
      if (this.#activeWork === 0) {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    }
  }

  pause(reason: string, operator = "system"): void {
    if (this.#state === "paused") return;
    if (this.#state !== "ready") throw new Error("only a ready executor can be paused");
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 8 || normalizedReason.length > 256) {
      throw new TypeError("pause reason must contain 8 to 256 characters");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{1,127}$/.test(operator)) {
      throw new TypeError("pause operator is invalid");
    }
    this.#state = "paused";
    this.#logger.info("executor.paused", "Executor stopped accepting new work", {
      activeWork: this.#activeWork,
      operator,
      reason: normalizedReason,
    });
  }

  resume(operator = "system"): void {
    if (this.#state !== "paused") throw new Error("only a paused executor can be resumed");
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{1,127}$/.test(operator)) {
      throw new TypeError("resume operator is invalid");
    }
    this.#state = "ready";
    this.#logger.info("executor.resumed", "Executor is accepting work", { operator });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "draining";
    this.#logger.info("executor.draining", "Executor is draining active work", {
      activeWork: this.#activeWork,
    });
    if (this.#activeWork > 0) {
      await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
    }
    try {
      await this.#chain.close();
      this.#chainStatus = "closed";
      this.#state = "stopped";
      this.#logger.info("executor.stopped", "Executor stopped after draining active work");
    } finally {
      if (this.#lifetimeHandle !== undefined) clearInterval(this.#lifetimeHandle);
      this.#lifetimeHandle = undefined;
    }
  }
}
