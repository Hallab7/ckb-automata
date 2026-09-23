export type WebNetwork = "testnet";

export interface WebEnvironment {
  readonly apiUrl: string;
  readonly network: WebNetwork;
}

function apiUrl(value: string | undefined): string {
  if (value === undefined) throw new Error("NEXT_PUBLIC_AUTOMATA_API_URL is required");
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("NEXT_PUBLIC_AUTOMATA_API_URL must be an HTTP(S) origin");
  }
  return `${parsed.origin}/`;
}

export function parseWebEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): WebEnvironment {
  const network = input["NEXT_PUBLIC_CKB_NETWORK"];
  if (network !== "testnet") throw new Error("NEXT_PUBLIC_CKB_NETWORK must be testnet");
  return Object.freeze({
    apiUrl: apiUrl(input["NEXT_PUBLIC_AUTOMATA_API_URL"]),
    network,
  });
}
