import localManifest from "../../../deploy/manifests/local.json" with { type: "json" };

import {
  DEPLOYED_CONTRACT_NAMES,
  validateDeploymentManifest,
  type CellDepIdentity,
  type DeployedContractName,
  type DeploymentManifest,
  type ManifestIssue,
  type ScriptHashType,
} from "./job-inspection.ts";
import { parseHash32, type Hash32 } from "./chain-values.ts";

export interface HashedManifestEntry {
  readonly genesisHash: string;
  readonly manifestSha256: string;
  readonly manifest: unknown;
  readonly confirmationDepth: number;
}

export interface RegisteredContract {
  readonly script: {
    readonly codeHash: Hash32;
    readonly hashType: ScriptHashType;
  };
  readonly cellDep: CellDepIdentity;
  readonly binarySha256: string;
  readonly sizeBytes: number;
}

export interface RegisteredDeployment {
  readonly network: string;
  readonly genesisHash: Hash32;
  readonly manifestSha256: string;
  readonly rpcUrl: string;
  readonly contracts: Readonly<Record<DeployedContractName, RegisteredContract>>;
  readonly confirmation: {
    readonly requiredDepth: number;
    readonly deploymentTransactionHash: Hash32;
    readonly deploymentBlockHash: Hash32;
    readonly verificationTransactionHash: Hash32;
    readonly verificationBlockHash: Hash32;
    readonly verificationKind: string;
    readonly verificationContract: DeployedContractName;
  };
  readonly manifest: DeploymentManifest;
}

export type DeploymentRegistryLoadResult =
  | { readonly status: "ok"; readonly deployment: RegisteredDeployment }
  | { readonly status: "not_found"; readonly genesisHash: Hash32 }
  | {
      readonly status: "integrity_mismatch";
      readonly genesisHash: Hash32;
      readonly expectedSha256: string;
      readonly actualSha256: string;
    }
  | {
      readonly status: "invalid_manifest";
      readonly genesisHash: Hash32;
      readonly issues: readonly ManifestIssue[];
    };

export interface DeploymentRegistry {
  readonly genesisHashes: readonly Hash32[];
  load(genesisHash: string): Promise<DeploymentRegistryLoadResult>;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("manifest numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("manifest must contain only JSON values");
  }
  if (seen.has(value)) {
    throw new TypeError("manifest must not contain cycles");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => canonicalJson(item, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashDeploymentManifest(manifest: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson(manifest));
  return bytesToHex(await globalThis.crypto.subtle.digest("SHA-256", encoded));
}

function registeredDeployment(
  manifest: DeploymentManifest,
  manifestSha256: string,
  confirmationDepth: number,
): RegisteredDeployment {
  const contracts = Object.fromEntries(
    DEPLOYED_CONTRACT_NAMES.map((name) => {
      const contract = manifest.contracts[name];
      return [
        name,
        Object.freeze({
          script: Object.freeze({ codeHash: contract.codeHash, hashType: contract.hashType }),
          cellDep: contract.cellDep,
          binarySha256: contract.binarySha256,
          sizeBytes: contract.sizeBytes,
        }),
      ];
    }),
  ) as unknown as Record<DeployedContractName, RegisteredContract>;

  return Object.freeze({
    network: manifest.network,
    genesisHash: manifest.genesisHash,
    manifestSha256,
    rpcUrl: manifest.rpcUrl,
    contracts: Object.freeze(contracts),
    confirmation: Object.freeze({
      requiredDepth: confirmationDepth,
      deploymentTransactionHash: manifest.deployment.transactionHash,
      deploymentBlockHash: manifest.deployment.blockHash,
      verificationTransactionHash: manifest.verification.transactionHash,
      verificationBlockHash: manifest.verification.blockHash,
      verificationKind: manifest.verification.kind,
      verificationContract: manifest.verification.contract,
    }),
    manifest,
  });
}

export function createDeploymentRegistry(
  entries: readonly HashedManifestEntry[],
): DeploymentRegistry {
  const byGenesis = new Map<Hash32, HashedManifestEntry>();
  for (const entry of entries) {
    const genesisHash = parseHash32(entry.genesisHash);
    if (!SHA256_PATTERN.test(entry.manifestSha256)) {
      throw new TypeError("manifestSha256 must be a lowercase SHA-256 digest");
    }
    if (!Number.isSafeInteger(entry.confirmationDepth) || entry.confirmationDepth < 1) {
      throw new RangeError("confirmationDepth must be a positive safe integer");
    }
    if (byGenesis.has(genesisHash)) {
      throw new Error(`duplicate deployment registry entry for ${genesisHash}`);
    }
    byGenesis.set(genesisHash, Object.freeze({ ...entry, genesisHash }));
  }

  const genesisHashes = Object.freeze([...byGenesis.keys()].toSorted());
  return Object.freeze({
    genesisHashes,
    async load(genesisHashValue: string): Promise<DeploymentRegistryLoadResult> {
      const genesisHash = parseHash32(genesisHashValue);
      const entry = byGenesis.get(genesisHash);
      if (!entry) {
        return { status: "not_found", genesisHash };
      }

      const actualSha256 = await hashDeploymentManifest(entry.manifest);
      if (actualSha256 !== entry.manifestSha256) {
        return {
          status: "integrity_mismatch",
          genesisHash,
          expectedSha256: entry.manifestSha256,
          actualSha256,
        };
      }

      const validation = validateDeploymentManifest(entry.manifest, genesisHash);
      if (validation.status === "invalid") {
        return { status: "invalid_manifest", genesisHash, issues: validation.issues };
      }
      return {
        status: "ok",
        deployment: registeredDeployment(
          validation.manifest,
          entry.manifestSha256,
          entry.confirmationDepth,
        ),
      };
    },
  });
}

export const LOCAL_DEPLOYMENT_MANIFEST_SHA256 =
  "41b5304a21dab6831e989ad450c3e9fc6e400a1888d76ae65e73f9888eccced5" as const;

export const deploymentRegistry = createDeploymentRegistry([
  {
    genesisHash: localManifest.genesisHash,
    manifestSha256: LOCAL_DEPLOYMENT_MANIFEST_SHA256,
    manifest: localManifest,
    confirmationDepth: 1,
  },
]);
