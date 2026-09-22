import { Controller, Get, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import type { AutomataEnvironment } from "@ckb-automata/config";
import { deploymentRegistry, type DeploymentRegistry } from "@ckb-automata/core";

import type { CkbReadClient } from "./ckb-client.ts";

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

export type NetworkMetadataChainClient = Pick<CkbReadClient, "getGenesisHash" | "getTipHeader">;

interface NetworkMetadataDependencies {
  readonly registry?: DeploymentRegistry;
}

export class NetworkMetadataService {
  readonly #environment: AutomataEnvironment;
  readonly #registry: DeploymentRegistry;
  readonly #ckbClient: NetworkMetadataChainClient;

  constructor(
    environment: AutomataEnvironment,
    ckbClient: NetworkMetadataChainClient,
    dependencies: NetworkMetadataDependencies = {},
  ) {
    this.#environment = environment;
    this.#registry = dependencies.registry ?? deploymentRegistry;
    this.#ckbClient = ckbClient;
  }

  async read(): Promise<NetworkMetadata> {
    const loaded = await this.#registry.load(this.#environment.CKB_GENESIS_HASH);
    if (loaded.status !== "ok") throw new Error("configured deployment is unavailable");
    if (loaded.deployment.network !== this.#environment.CKB_NETWORK) {
      throw new Error("configured deployment network does not match the environment");
    }

    const [remoteGenesis, tip] = await Promise.all([
      this.#ckbClient.getGenesisHash(),
      this.#ckbClient.getTipHeader(),
    ]);
    if (remoteGenesis !== this.#environment.CKB_GENESIS_HASH) {
      throw new Error("RPC genesis does not match the configured network");
    }

    return Object.freeze({
      network: this.#environment.CKB_NETWORK,
      genesisHash: remoteGenesis,
      tip: Object.freeze({
        blockNumber: tip.number.toString(),
        blockHash: tip.hash,
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
