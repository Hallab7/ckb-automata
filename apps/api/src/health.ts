import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";

import { Controller, Get, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import { deploymentRegistry, parseBlockNumber } from "@ckb-automata/core";

export const HEALTH_DEPENDENCIES = ["postgres", "redis", "rpc", "deployment", "indexLag"] as const;

export type HealthDependencyName = (typeof HEALTH_DEPENDENCIES)[number];

export interface HealthProbe {
  readonly name: HealthDependencyName;
  readonly check: () => Promise<Readonly<Record<string, unknown>> | void>;
}

export interface DependencyHealth {
  readonly status: "up" | "down";
  readonly latencyMs: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface LivenessReport {
  readonly status: "ok";
  readonly service: "ckb-automata:api";
  readonly uptimeSeconds: number;
}

export interface ReadinessReport {
  readonly status: "ready" | "not_ready";
  readonly service: "ckb-automata:api";
  readonly dependencies: Readonly<Record<HealthDependencyName, DependencyHealth>>;
}

const PROBE_TIMEOUT_MS = 2_000;
const MAX_INDEX_LAG_BLOCKS = 12n;

function elapsed(started: number): number {
  return Math.max(0, Math.round((performance.now() - started) * 100) / 100);
}

function socketProbe(urlValue: string, tls: boolean): Promise<void> {
  const url = new URL(urlValue);
  const defaultPort = tls ? 6_379 : url.protocol === "postgresql:" ? 5_432 : 6_379;
  const port = url.port ? Number(url.port) : defaultPort;
  return new Promise((resolve, reject) => {
    const socket = tls
      ? connectTls({ host: url.hostname, port, servername: url.hostname })
      : connectTcp({ host: url.hostname, port });
    const finish = (error?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(new Error("timeout")));
    socket.once(tls ? "secureConnect" : "connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

function rpcClient(urlValue: string) {
  const url = new URL(urlValue);
  let id = 0;
  return async (method: string, params: readonly unknown[] = []): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ++id, jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const payload = (await response.json()) as {
      readonly result?: unknown;
      readonly error?: { readonly message?: string };
    };
    if (!response.ok || payload.error) throw new Error("RPC request failed");
    return payload.result;
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("RPC response is not an object");
  }
  return value as Record<string, unknown>;
}

function requiredEnvironment(
  input: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = input[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function createDefaultHealthProbes(
  input: Readonly<Record<string, string | undefined>>,
): readonly HealthProbe[] {
  const databaseUrl = requiredEnvironment(input, "DATABASE_URL");
  const redisUrl = requiredEnvironment(input, "REDIS_URL");
  const rpcUrl = requiredEnvironment(input, "CKB_RPC_URL");
  const indexerUrl = requiredEnvironment(input, "CKB_INDEXER_URL");
  const genesisHash = requiredEnvironment(input, "CKB_GENESIS_HASH");
  const chainRpc = rpcClient(rpcUrl);
  const indexerRpc = rpcClient(indexerUrl);

  return Object.freeze([
    Object.freeze({
      name: "postgres" as const,
      check: async () => socketProbe(databaseUrl, false),
    }),
    Object.freeze({
      name: "redis" as const,
      check: async () => socketProbe(redisUrl, new URL(redisUrl).protocol === "rediss:"),
    }),
    Object.freeze({
      name: "rpc" as const,
      check: async () => {
        const [remoteGenesis, tipValue] = await Promise.all([
          chainRpc("get_block_hash", ["0x0"]),
          chainRpc("get_tip_header"),
        ]);
        if (remoteGenesis !== genesisHash) throw new Error("wrong network");
        const tip = record(tipValue);
        return Object.freeze({ blockNumber: parseBlockNumber(String(tip["number"])).toString() });
      },
    }),
    Object.freeze({
      name: "deployment" as const,
      check: async () => {
        const loaded = await deploymentRegistry.load(genesisHash);
        if (loaded.status !== "ok") throw new Error("deployment unavailable");
        return Object.freeze({ manifestSha256: loaded.deployment.manifestSha256 });
      },
    }),
    Object.freeze({
      name: "indexLag" as const,
      check: async () => {
        const [chainTipValue, indexerTipValue] = await Promise.all([
          chainRpc("get_tip_header"),
          indexerRpc("get_tip"),
        ]);
        const chainTip = parseBlockNumber(String(record(chainTipValue)["number"]));
        const indexerTip = parseBlockNumber(String(record(indexerTipValue)["block_number"]));
        const lag = chainTip > indexerTip ? chainTip - indexerTip : 0n;
        if (lag > MAX_INDEX_LAG_BLOCKS) throw new Error("index lag exceeded");
        return Object.freeze({
          lagBlocks: lag.toString(),
          maximumLagBlocks: MAX_INDEX_LAG_BLOCKS.toString(),
        });
      },
    }),
  ]);
}

export class HealthService {
  readonly #probes: readonly HealthProbe[];

  constructor(probes: readonly HealthProbe[] = createDefaultHealthProbes(process.env)) {
    const byName = new Map(probes.map((probe) => [probe.name, probe]));
    if (
      probes.length !== HEALTH_DEPENDENCIES.length ||
      byName.size !== HEALTH_DEPENDENCIES.length ||
      HEALTH_DEPENDENCIES.some((name) => !byName.has(name))
    ) {
      throw new Error("health probes must define every dependency exactly once");
    }
    this.#probes = Object.freeze([...probes]);
  }

  liveness(): LivenessReport {
    return Object.freeze({
      status: "ok",
      service: "ckb-automata:api",
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  async readiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.#probes.map(async (probe) => {
        const started = performance.now();
        try {
          const details = await probe.check();
          return [
            probe.name,
            Object.freeze({
              status: "up" as const,
              latencyMs: elapsed(started),
              ...(details ? { details: Object.freeze({ ...details }) } : {}),
            }),
          ] as const;
        } catch {
          return [
            probe.name,
            Object.freeze({ status: "down" as const, latencyMs: elapsed(started) }),
          ] as const;
        }
      }),
    );
    const dependencies = Object.freeze(
      Object.fromEntries(entries) as Record<HealthDependencyName, DependencyHealth>,
    );
    const ready = HEALTH_DEPENDENCIES.every((name) => dependencies[name].status === "up");
    return Object.freeze({
      status: ready ? "ready" : "not_ready",
      service: "ckb-automata:api",
      dependencies,
    });
  }
}

Injectable()(HealthService);

export class HealthController {
  readonly #health: HealthService;

  constructor(health: HealthService) {
    this.#health = health;
  }

  live(): LivenessReport {
    return this.#health.liveness();
  }

  async ready(): Promise<ReadinessReport> {
    const report = await this.#health.readiness();
    if (report.status !== "ready") throw new ServiceUnavailableException(report);
    return report;
  }
}

Inject(HealthService)(HealthController, undefined, 0);
Controller("health")(HealthController);
Get("live")(
  HealthController.prototype,
  "live",
  Object.getOwnPropertyDescriptor(HealthController.prototype, "live")!,
);
Get("ready")(
  HealthController.prototype,
  "ready",
  Object.getOwnPropertyDescriptor(HealthController.prototype, "ready")!,
);
