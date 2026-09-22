import { Controller, Get, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import type { AutomataEnvironment } from "@ckb-automata/config";
import {
  deploymentRegistry,
  parseBlockNumber,
  parseHash32,
  type DeploymentRegistry,
} from "@ckb-automata/core";

export const SUPPORTED_POLICY_VERSIONS = Object.freeze({
  deadline: Object.freeze([1] as const),
  recurring: Object.freeze([1] as const),
});

export interface NetworkMetadata {
  readonly network: AutomataEnvironment["CKB_NETWORK"];
  readonly genesisHash: string;
  readonly tip: {
    readonly blockNumber: string;
    readonly blockHash: string;
  };
  readonly confirmationDepth: number;
  readonly deploymentManifestHash: string;
  readonly supportedPolicyVersions: typeof SUPPORTED_POLICY_VERSIONS;
}

export type NetworkMetadataRpc = (
  method: "get_block_hash" | "get_tip_header",
  parameters?: readonly unknown[],
) => Promise<unknown>;

interface NetworkMetadataDependencies {
  readonly registry?: DeploymentRegistry;
  readonly rpc?: NetworkMetadataRpc;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function createRpc(url: string): NetworkMetadataRpc {
  let requestId = 0;
  return async (method, parameters = []) => {
    const id = ++requestId;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: parameters }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error("RPC request failed");
    const payload = record(await response.json(), "RPC response");
    if (payload["jsonrpc"] !== "2.0" || payload["id"] !== id || "error" in payload) {
      throw new Error("RPC response envelope is invalid");
    }
    if (!("result" in payload)) throw new Error("RPC response has no result");
    return payload["result"];
  };
}

export class NetworkMetadataService {
  readonly #environment: AutomataEnvironment;
  readonly #registry: DeploymentRegistry;
  readonly #rpc: NetworkMetadataRpc;

  constructor(environment: AutomataEnvironment, dependencies: NetworkMetadataDependencies = {}) {
    this.#environment = environment;
    this.#registry = dependencies.registry ?? deploymentRegistry;
    this.#rpc = dependencies.rpc ?? createRpc(environment.CKB_RPC_URL);
  }

  async read(): Promise<NetworkMetadata> {
    const loaded = await this.#registry.load(this.#environment.CKB_GENESIS_HASH);
    if (loaded.status !== "ok") throw new Error("configured deployment is unavailable");
    if (loaded.deployment.network !== this.#environment.CKB_NETWORK) {
      throw new Error("configured deployment network does not match the environment");
    }

    const [remoteGenesisValue, tipValue] = await Promise.all([
      this.#rpc("get_block_hash", ["0x0"]),
      this.#rpc("get_tip_header"),
    ]);
    if (typeof remoteGenesisValue !== "string") throw new Error("RPC genesis is not a hash");
    const remoteGenesis = parseHash32(remoteGenesisValue);
    if (remoteGenesis !== this.#environment.CKB_GENESIS_HASH) {
      throw new Error("RPC genesis does not match the configured network");
    }
    const tip = record(tipValue, "tip header");
    if (typeof tip["number"] !== "string" || typeof tip["hash"] !== "string") {
      throw new Error("tip header has invalid fields");
    }

    return Object.freeze({
      network: this.#environment.CKB_NETWORK,
      genesisHash: remoteGenesis,
      tip: Object.freeze({
        blockNumber: parseBlockNumber(tip["number"]).toString(),
        blockHash: parseHash32(tip["hash"]),
      }),
      confirmationDepth: loaded.deployment.confirmation.requiredDepth,
      deploymentManifestHash: loaded.deployment.manifestSha256,
      supportedPolicyVersions: SUPPORTED_POLICY_VERSIONS,
    });
  }
}

export class NetworkMetadataController {
  readonly #networkMetadata: NetworkMetadataService;

  constructor(networkMetadata: NetworkMetadataService) {
    this.#networkMetadata = networkMetadata;
  }

  async get(): Promise<NetworkMetadata> {
    try {
      return await this.#networkMetadata.read();
    } catch {
      throw new ServiceUnavailableException({
        status: "unavailable",
        code: "NETWORK_METADATA_UNAVAILABLE",
      });
    }
  }
}

Injectable()(NetworkMetadataService);
Inject(NetworkMetadataService)(NetworkMetadataController, undefined, 0);
Controller("network")(NetworkMetadataController);
Get()(
  NetworkMetadataController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(NetworkMetadataController.prototype, "get")!,
);
