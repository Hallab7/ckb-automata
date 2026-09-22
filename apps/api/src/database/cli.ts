import { migrateDatabase, rollbackDatabase } from "./migrator.ts";

function parseTarget(arguments_: readonly string[]): number | undefined {
  const target = arguments_.find((argument) => argument.startsWith("--to="));
  if (!target) return undefined;
  const value = Number(target.slice("--to=".length));
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("--to must be a non-negative integer");
  return value;
}

const command = process.argv[2];
if (command !== "up" && command !== "down") {
  throw new Error("Usage: database migration command <up [--to=N] | down>");
}

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) throw new Error("DATABASE_URL is required");

try {
  const targetVersion = parseTarget(process.argv.slice(3));
  const result =
    command === "up"
      ? await migrateDatabase({
          connectionString,
          ...(targetVersion === undefined ? {} : { targetVersion }),
        })
      : await rollbackDatabase({ connectionString });
  console.log(
    JSON.stringify({
      event: "database_migration_complete",
      direction: result.direction,
      changed: result.changed,
      currentVersion: result.currentVersion,
    }),
  );
} catch (error) {
  const message =
    error instanceof Error
      ? error.message.replaceAll(connectionString, "[REDACTED]")
      : "unknown error";
  console.error(JSON.stringify({ event: "database_migration_failed", message }));
  process.exitCode = 1;
}
