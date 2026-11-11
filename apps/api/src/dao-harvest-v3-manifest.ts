import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PERSONAL, blake2b, hexToBytes } from "@nervosnetwork/ckb-sdk-utils";
import {
  parseHash32,
  type CellDepIdentity,
  type DaoHarvestV3DeploymentIdentity,
  type Hash32,
} from "@ckb-automata/core";
import type { CkbReadClient } from "./ckb-client.ts";

interface AuditedContract {
  readonly codeHash: Hash32;
  readonly hashType: "data1";
  readonly cellDep: CellDepIdentity;
  readonly binarySha256: string;
  readonly sizeBytes: number;
}
export interface DaoHarvestV3DeploymentManifest {
  readonly schemaVersion: 3;
  readonly releaseVersion: string;
  readonly network: "ckb_testnet";
  readonly genesisHash: Hash32;
  readonly sourceRevision: string;
  readonly predecessorManifests: readonly string[];
  readonly secp256k1Blake160: {
    readonly codeHash: Hash32;
    readonly hashType: "type";
    readonly cellDep: CellDepIdentity;
  };
  readonly nervosDao: {
    readonly codeHash: Hash32;
    readonly hashType: "type";
    readonly cellDep: CellDepIdentity;
  };
  readonly contracts: Readonly<
    Record<"jobLock" | "policy" | "vaultLock" | "compensationLock", AuditedContract>
  >;
}
export interface VerifiedDaoHarvestV3Deployment {
  readonly deployment: DaoHarvestV3DeploymentIdentity;
  readonly manifest: DaoHarvestV3DeploymentManifest;
  readonly manifestSha256: string;
}
const object = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string) => {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
};
function dependency(value: unknown, name: string): CellDepIdentity {
  const item = object(value, name);
  const outPoint = object(item["outPoint"], `${name}.outPoint`);
  if (item["depType"] !== "code" && item["depType"] !== "depGroup")
    throw new TypeError(`${name}.depType is invalid`);
  const index = text(outPoint["index"], `${name}.outPoint.index`);
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(index))
    throw new TypeError(`${name}.outPoint.index is invalid`);
  return Object.freeze({
    outPoint: Object.freeze({
      txHash: parseHash32(text(outPoint["txHash"], `${name}.outPoint.txHash`)),
      index: index as `0x${string}`,
    }),
    depType: item["depType"],
  });
}
function system(value: unknown, name: string) {
  const item = object(value, name);
  if (item["hashType"] !== "type") throw new TypeError(`${name}.hashType is invalid`);
  return Object.freeze({
    codeHash: parseHash32(text(item["codeHash"], `${name}.codeHash`)),
    hashType: "type" as const,
    cellDep: dependency(item["cellDep"], `${name}.cellDep`),
  });
}
function contract(value: unknown, name: string): AuditedContract {
  const item = object(value, name);
  const binarySha256 = text(item["binarySha256"], `${name}.binarySha256`);
  const sizeBytes = item["sizeBytes"];
  const cellDep = dependency(item["cellDep"], `${name}.cellDep`);
  if (
    item["hashType"] !== "data1" ||
    !/^[0-9a-f]{64}$/.test(binarySha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    Number(sizeBytes) < 1 ||
    cellDep.depType !== "code"
  )
    throw new TypeError(`${name} audit metadata is invalid`);
  return Object.freeze({
    codeHash: parseHash32(text(item["codeHash"], `${name}.codeHash`)),
    hashType: "data1",
    cellDep,
    binarySha256,
    sizeBytes: Number(sizeBytes),
  });
}
export function parseDaoHarvestV3DeploymentManifest(
  value: unknown,
): DaoHarvestV3DeploymentManifest {
  const item = object(value, "DAO Harvest V3 manifest");
  if (item["schemaVersion"] !== 3 || item["network"] !== "ckb_testnet")
    throw new TypeError("DAO Harvest V3 manifest must target CKB testnet schema 3");
  const releaseVersion = text(item["releaseVersion"], "releaseVersion");
  const sourceRevision = text(item["sourceRevision"], "sourceRevision");
  if (
    !/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(releaseVersion) ||
    !/^[0-9a-f]{40}$/.test(sourceRevision)
  )
    throw new TypeError("V3 release identity is invalid");
  const predecessors = item["predecessorManifests"] ?? [];
  if (
    !Array.isArray(predecessors) ||
    predecessors.length > 8 ||
    predecessors.some(
      (entry) =>
        typeof entry !== "string" ||
        !/^dao-harvest-v3-testnet-v[0-9]+\.[0-9]+\.[0-9]+\.json$/.test(entry),
    ) ||
    new Set(predecessors).size !== predecessors.length
  )
    throw new TypeError("V3 predecessor manifests are invalid");
  const contracts = object(item["contracts"], "contracts");
  return Object.freeze({
    schemaVersion: 3,
    releaseVersion,
    network: "ckb_testnet",
    genesisHash: parseHash32(text(item["genesisHash"], "genesisHash")),
    sourceRevision,
    predecessorManifests: Object.freeze(predecessors as string[]),
    secp256k1Blake160: system(item["secp256k1Blake160"], "secp256k1Blake160"),
    nervosDao: system(item["nervosDao"], "nervosDao"),
    contracts: Object.freeze({
      jobLock: contract(contracts["jobLock"], "contracts.jobLock"),
      policy: contract(contracts["policy"], "contracts.policy"),
      vaultLock: contract(contracts["vaultLock"], "contracts.vaultLock"),
      compensationLock: contract(contracts["compensationLock"], "contracts.compensationLock"),
    }),
  });
}
function dataHash(bytes: Uint8Array): Hash32 {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(bytes);
  return parseHash32(`0x${hasher.digest("hex")}`);
}
async function loadOne(
  path: string,
  chain: Pick<CkbReadClient, "getCellLive" | "getGenesisHash">,
  expectedGenesis: string,
) {
  const bytes = await readFile(path);
  const manifest = parseDaoHarvestV3DeploymentManifest(JSON.parse(bytes.toString("utf8")));
  const genesis = parseHash32(expectedGenesis);
  if (manifest.genesisHash !== genesis || (await chain.getGenesisHash()) !== genesis)
    throw new Error("DAO Harvest V3 manifest does not match the configured chain genesis");
  for (const [name, deployed] of Object.entries(manifest.contracts)) {
    const live = await chain.getCellLive(deployed.cellDep.outPoint);
    if (!live) throw new Error(`${name} V3 code cell is not live`);
    const code = hexToBytes(live.outputData.toString());
    if (
      code.length !== deployed.sizeBytes ||
      createHash("sha256").update(code).digest("hex") !== deployed.binarySha256 ||
      dataHash(code) !== deployed.codeHash
    )
      throw new Error(`${name} V3 code cell does not match the audited manifest`);
  }
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  const deployment: DaoHarvestV3DeploymentIdentity = Object.freeze({
    network: "ckb_testnet",
    genesisHash: manifest.genesisHash,
    manifestSha256,
    secp256k1Blake160: manifest.secp256k1Blake160,
    nervosDao: manifest.nervosDao,
    contracts: Object.freeze({
      jobLock: manifest.contracts.jobLock,
      policy: manifest.contracts.policy,
      vaultLock: manifest.contracts.vaultLock,
      compensationLock: manifest.contracts.compensationLock,
    }),
  });
  return Object.freeze({ deployment, manifest, manifestSha256 });
}
export async function loadVerifiedDaoHarvestV3Deployments(
  path: string,
  chain: Pick<CkbReadClient, "getCellLive" | "getGenesisHash">,
  expectedGenesis: string,
): Promise<readonly VerifiedDaoHarvestV3Deployment[]> {
  const active = await loadOne(path, chain, expectedGenesis);
  const prior = await Promise.all(
    active.manifest.predecessorManifests.map((name) =>
      loadOne(resolve(dirname(path), name), chain, expectedGenesis),
    ),
  );
  const all = [active, ...prior];
  if (
    new Set(all.map(({ deployment }) => deployment.contracts.jobLock.codeHash)).size !== all.length
  )
    throw new Error("DAO Harvest V3 revisions must have unique Job Lock code hashes");
  return Object.freeze(all);
}
