import postgres from "postgres";

import { deploymentRegistry, type DeploymentRegistry } from "@ckb-automata/core";

const RPC_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NETWORK_INITIALIZATION_LOCK_ID = 4_341_268_216;

export interface NetworkInitializationInput {
  readonly connectionString: string;
  readonly genesisHash: string;
  readonly networkId: string;
  readonly rpcProfile: string;
}

export interface NetworkInitializationRecord {
  readonly confirmationDepth: number;
  readonly deploymentManifestHash: string;
  readonly genesisHash: string;
  readonly networkId: string;
  readonly rpcProfile: string;
}

interface StoredNetworkRow {
  readonly confirmation_depth: number;
  readonly deployment_manifest_hash: string;
  readonly genesis_hash: string;
  readonly id: string;
  readonly rpc_profile: string;
}

export interface NetworkInitializationResult {
  readonly changed: boolean;
  readonly network: NetworkInitializationRecord;
}

function assertConnectionString(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgresql://");
  }
}

export async function resolveNetworkInitialization(
  input: Omit<NetworkInitializationInput, "connectionString">,
  registry: DeploymentRegistry = deploymentRegistry,
): Promise<NetworkInitializationRecord> {
  if (!RPC_PROFILE_PATTERN.test(input.rpcProfile)) {
    throw new Error("AUTOMATA_PROFILE is not a valid database RPC profile");
  }
  const loaded = await registry.load(input.genesisHash);
  if (loaded.status !== "ok") {
    throw new Error(`deployment registry rejected the configured genesis (${loaded.status})`);
  }
  if (loaded.deployment.network !== input.networkId) {
    throw new Error("configured deployment network does not match CKB_NETWORK");
  }
  return Object.freeze({
    confirmationDepth: loaded.deployment.confirmation.requiredDepth,
    deploymentManifestHash: loaded.deployment.manifestSha256,
    genesisHash: loaded.deployment.genesisHash,
    networkId: loaded.deployment.network,
    rpcProfile: input.rpcProfile,
  });
}

export function assertStoredNetwork(
  stored: StoredNetworkRow | undefined,
  expected: NetworkInitializationRecord,
): void {
  if (stored === undefined) throw new Error("network initialization did not return a database row");
  const matches =
    stored.id === expected.networkId &&
    stored.genesis_hash === expected.genesisHash &&
    stored.rpc_profile === expected.rpcProfile &&
    stored.confirmation_depth === expected.confirmationDepth &&
    stored.deployment_manifest_hash === expected.deploymentManifestHash;
  if (!matches) {
    throw new Error("stored network metadata conflicts with the verified deployment manifest");
  }
}

export async function initializeNetworkDatabase(
  input: NetworkInitializationInput,
): Promise<NetworkInitializationResult> {
  assertConnectionString(input.connectionString);
  const expected = await resolveNetworkInitialization(input);
  const client = postgres(input.connectionString, {
    connect_timeout: 5,
    idle_timeout: 2,
    max: 1,
    onnotice: () => undefined,
  });
  try {
    return await client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(${NETWORK_INITIALIZATION_LOCK_ID})`;
      const inserted = await sql<StoredNetworkRow[]>`
        INSERT INTO networks (
          id,
          genesis_hash,
          rpc_profile,
          confirmation_depth,
          deployment_manifest_hash
        ) VALUES (
          ${expected.networkId},
          ${expected.genesisHash},
          ${expected.rpcProfile},
          ${expected.confirmationDepth},
          ${expected.deploymentManifestHash}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
      `;
      const [stored] =
        inserted.length > 0
          ? inserted
          : await sql<StoredNetworkRow[]>`
              SELECT id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
              FROM networks
              WHERE id = ${expected.networkId}
              FOR SHARE
            `;
      assertStoredNetwork(stored, expected);
      return Object.freeze({ changed: inserted.length === 1, network: expected });
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}
