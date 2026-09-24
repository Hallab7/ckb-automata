import type { WebEnvironment } from "./environment.ts";

export interface PublicDeploymentIdentity {
  readonly deploymentManifestHash: string;
  readonly genesisHash: string;
  readonly network: "ckb_testnet";
}

const LIVE_PATH_PREFIXES = ["/activity", "/automations", "/settings"] as const;

export function requiresPublicDeploymentVerification(pathname: string): boolean {
  return LIVE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("public backend returned invalid network metadata");
  }
  return value as Readonly<Record<string, unknown>>;
}

export function assertPublicDeploymentIdentity(
  value: unknown,
  expected: Pick<WebEnvironment, "genesisHash" | "manifestSha256" | "network">,
): PublicDeploymentIdentity {
  const metadata = record(value);
  if (
    expected.network !== "testnet" ||
    metadata["network"] !== "ckb_testnet" ||
    metadata["genesisHash"] !== expected.genesisHash ||
    metadata["deploymentManifestHash"] !== expected.manifestSha256
  ) {
    throw new Error("public backend identity does not match this frontend deployment");
  }
  return Object.freeze({
    deploymentManifestHash: expected.manifestSha256,
    genesisHash: expected.genesisHash,
    network: "ckb_testnet",
  });
}
