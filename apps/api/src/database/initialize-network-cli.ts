import { initializeNetworkDatabase } from "./network-initialization.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const connectionString = required("DATABASE_URL");

try {
  const result = await initializeNetworkDatabase({
    connectionString,
    genesisHash: required("CKB_GENESIS_HASH"),
    networkId: required("CKB_NETWORK"),
    rpcProfile: required("AUTOMATA_PROFILE"),
  });
  console.log(
    JSON.stringify({
      event: "network_initialization_complete",
      changed: result.changed,
      network: result.network.networkId,
      deploymentManifestHash: result.network.deploymentManifestHash,
    }),
  );
} catch (error) {
  const message =
    error instanceof Error
      ? error.message.replaceAll(connectionString, "[REDACTED]")
      : "unknown error";
  console.error(JSON.stringify({ event: "network_initialization_failed", message }));
  process.exitCode = 1;
}
