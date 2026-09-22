import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";

import { Controller, Get, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import { deploymentRegistry } from "@ckb-automata/core";

import type { CkbReadClient } from "./ckb-client.ts";

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
  ckbClient: Pick<CkbReadClient, "getGenesisHash" | "getIndexerTip" | "getTipHeader">,
): readonly HealthProbe[] {
  const databaseUrl = requiredEnvironment(input, "DATABASE_URL");
  const redisUrl = requiredEnvironment(input, "REDIS_URL");
  const genesisHash = requiredEnvironment(input, "CKB_GENESIS_HASH");

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
        const [remoteGenesis, tip] = await Promise.all([
          ckbClient.getGenesisHash(),
          ckbClient.getTipHeader(),
        ]);
        if (remoteGenesis !== genesisHash) throw new Error("wrong network");
        return Object.freeze({ blockNumber: tip.number.toString() });
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
        const [chainTip, indexerTip] = await Promise.all([
          ckbClient.getTipHeader(),
          ckbClient.getIndexerTip(),
        ]);
        const lag =
          chainTip.number > indexerTip.blockNumber ? chainTip.number - indexerTip.blockNumber : 0n;
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

  constructor(probes: readonly HealthProbe[]) {
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
