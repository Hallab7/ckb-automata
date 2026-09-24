import { TESTNET_DEPLOYMENT_MANIFEST_SHA256, TESTNET_GENESIS_HASH } from "@ckb-automata/core";

export type WebNetwork = "testnet";

export interface WebEnvironment {
  readonly apiUrl: string;
  readonly genesisHash: string;
  readonly manifestSha256: string;
  readonly network: WebNetwork;
  readonly sseUrl: string;
}

function origin(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return `${parsed.origin}/`;
}

export function parseWebEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): WebEnvironment {
  const network = input["NEXT_PUBLIC_CKB_NETWORK"];
  if (network !== "testnet") throw new Error("NEXT_PUBLIC_CKB_NETWORK must be testnet");
  const apiUrl = origin(input["NEXT_PUBLIC_AUTOMATA_API_URL"], "NEXT_PUBLIC_AUTOMATA_API_URL");
  const sseUrl = origin(input["NEXT_PUBLIC_AUTOMATA_SSE_URL"], "NEXT_PUBLIC_AUTOMATA_SSE_URL");
  if (apiUrl !== sseUrl) throw new Error("public API and SSE origins must match");
  const genesisHash = input["NEXT_PUBLIC_CKB_GENESIS_HASH"];
  if (genesisHash !== TESTNET_GENESIS_HASH) {
    throw new Error("NEXT_PUBLIC_CKB_GENESIS_HASH must identify CKB Pudge testnet");
  }
  const manifestSha256 = input["NEXT_PUBLIC_DEPLOYMENT_MANIFEST_SHA256"];
  if (manifestSha256 !== TESTNET_DEPLOYMENT_MANIFEST_SHA256) {
    throw new Error("NEXT_PUBLIC_DEPLOYMENT_MANIFEST_SHA256 must identify the public deployment");
  }
  return Object.freeze({
    apiUrl,
    genesisHash,
    manifestSha256,
    network,
    sseUrl,
  });
}

export function browserWebEnvironment(): WebEnvironment {
  return parseWebEnvironment({
    // @ts-expect-error Next.js requires direct property access for build-time public env inlining.
    NEXT_PUBLIC_AUTOMATA_API_URL: process.env.NEXT_PUBLIC_AUTOMATA_API_URL,
    // @ts-expect-error Next.js requires direct property access for build-time public env inlining.
    NEXT_PUBLIC_AUTOMATA_SSE_URL: process.env.NEXT_PUBLIC_AUTOMATA_SSE_URL,
    // @ts-expect-error Next.js requires direct property access for build-time public env inlining.
    NEXT_PUBLIC_CKB_NETWORK: process.env.NEXT_PUBLIC_CKB_NETWORK,
    // @ts-expect-error Next.js requires direct property access for build-time public env inlining.
    NEXT_PUBLIC_CKB_GENESIS_HASH: process.env.NEXT_PUBLIC_CKB_GENESIS_HASH,
    // @ts-expect-error Next.js requires direct property access for build-time public env inlining.
    NEXT_PUBLIC_DEPLOYMENT_MANIFEST_SHA256: process.env.NEXT_PUBLIC_DEPLOYMENT_MANIFEST_SHA256,
  });
}
