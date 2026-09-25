import { ccc } from "@ckb-ccc/shell";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, type ScriptIdentity } from "@ckb-automata/core";

import { DatabaseClient } from "./client.ts";
import { PostgresLockResolutionRecorder } from "../lock-resolutions.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const connectionString = required("DATABASE_URL");
const database = DatabaseClient.open(connectionString);

try {
  const address = await ccc.Address.fromString(
    required("LOCK_ADDRESS"),
    new ccc.ClientPublicTestnet(),
  );
  if (address.script.hashType === "data2") {
    throw new Error("LOCK_ADDRESS uses an unsupported data2 lock script");
  }
  const lock: ScriptIdentity = Object.freeze({
    codeHash: parseHash32(address.script.codeHash),
    hashType: address.script.hashType,
    args: address.script.args,
  });
  await new PostgresLockResolutionRecorder(database.database, required("CKB_NETWORK")).remember([
    lock,
  ]);
  console.log(
    JSON.stringify({
      event: "lock_resolution_registered",
      lockHash: scriptToHash(lock),
      network: required("CKB_NETWORK"),
    }),
  );
} catch (error) {
  const message =
    error instanceof Error
      ? error.message.replaceAll(connectionString, "[REDACTED]")
      : "unknown error";
  console.error(JSON.stringify({ event: "lock_resolution_registration_failed", message }));
  process.exitCode = 1;
} finally {
  await database.close();
}
