import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import postgres from "postgres";

const DEFAULT_MIGRATIONS_DIRECTORY = new URL("../../../../database/migrations/", import.meta.url);
const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
const MIGRATION_LOCK_ID = 4_341_268_215;

export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly upSql: string;
  readonly downSql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationResult {
  readonly direction: "up" | "down";
  readonly changed: readonly number[];
  readonly currentVersion: number;
}

interface MigrationOptions {
  readonly connectionString: string;
  readonly migrationsDirectory?: URL;
  readonly targetVersion?: number;
}

interface JournalRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: Date;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

export async function loadMigrations(
  directory: URL = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<readonly DatabaseMigration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .toSorted();
  const parts = new Map<number, { name: string; up?: string; down?: string }>();

  for (const file of files) {
    const match = MIGRATION_FILE_PATTERN.exec(file);
    if (!match) continue;
    const version = Number(match[1]);
    const name = match[2]!;
    const direction = match[3] as "up" | "down";
    const existing = parts.get(version);
    if (existing && existing.name !== name) {
      throw new Error(`Migration ${version} has conflicting names`);
    }
    if (existing?.[direction] !== undefined) {
      throw new Error(`Migration ${version} has duplicate ${direction} SQL`);
    }
    const sql = await readFile(new URL(file, directory), "utf8");
    parts.set(version, { ...existing, name, [direction]: sql });
  }

  const versions = [...parts.keys()].toSorted((left, right) => left - right);
  if (versions.length === 0) throw new Error("No database migrations were found");

  return Object.freeze(
    versions.map((version, index) => {
      if (version !== index + 1) {
        throw new Error(`Migration sequence must be contiguous from 0001; found ${version}`);
      }
      const migration = parts.get(version);
      if (!migration?.up || !migration.down) {
        throw new Error(`Migration ${version} must have matching up and down SQL`);
      }
      if (!migration.up.trim() || !migration.down.trim()) {
        throw new Error(`Migration ${version} SQL must not be empty`);
      }
      return Object.freeze({
        version,
        name: migration.name,
        checksum: sha256(`${migration.up}\0${migration.down}`),
        upSql: migration.up,
        downSql: migration.down,
      });
    }),
  );
}

async function initializeJournal(sql: postgres.TransactionSql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS automata_schema_migrations (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL,
      checksum varchar(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readJournal(sql: postgres.TransactionSql): Promise<readonly AppliedMigration[]> {
  const rows = await sql.unsafe<JournalRow[]>(
    "SELECT version, name, checksum, applied_at FROM automata_schema_migrations ORDER BY version",
  );
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

function validateJournal(
  migrations: readonly DatabaseMigration[],
  applied: readonly AppliedMigration[],
): void {
  for (const journalEntry of applied) {
    const migration = migrations.find(({ version }) => version === journalEntry.version);
    if (!migration)
      throw new Error(`Applied migration ${journalEntry.version} is not in the repository`);
    if (migration.name !== journalEntry.name || migration.checksum !== journalEntry.checksum) {
      throw new Error(`Applied migration ${journalEntry.version} differs from the repository`);
    }
  }
}

function createClient(connectionString: string): postgres.Sql {
  assertConnectionString(connectionString);
  return postgres(connectionString, {
    connect_timeout: 5,
    idle_timeout: 2,
    max: 1,
    onnotice: () => undefined,
  });
}

export async function migrateDatabase(options: MigrationOptions): Promise<MigrationResult> {
  const migrations = await loadMigrations(options.migrationsDirectory);
  const maximumVersion = migrations.at(-1)?.version ?? 0;
  const targetVersion = options.targetVersion ?? maximumVersion;
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0 || targetVersion > maximumVersion) {
    throw new Error(`Target migration must be between 0 and ${maximumVersion}`);
  }

  const client = createClient(options.connectionString);
  try {
    return await client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
      await initializeJournal(sql);
      const applied = await readJournal(sql);
      validateJournal(migrations, applied);
      const currentVersion = applied.at(-1)?.version ?? 0;
      if (targetVersion < currentVersion) {
        throw new Error("Up migrations cannot target an earlier version; use the rollback command");
      }

      const changed: number[] = [];
      for (const migration of migrations) {
        if (migration.version <= currentVersion || migration.version > targetVersion) continue;
        await sql.unsafe(migration.upSql, [], { prepare: false });
        await sql.unsafe(
          "INSERT INTO automata_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        changed.push(migration.version);
      }
      return { direction: "up" as const, changed, currentVersion: targetVersion };
    });
  } finally {
    await client.end({ timeout: 2 });
  }
}

export async function rollbackDatabase(
  options: Omit<MigrationOptions, "targetVersion">,
): Promise<MigrationResult> {
  const migrations = await loadMigrations(options.migrationsDirectory);
  const client = createClient(options.connectionString);
  try {
    return await client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
      await initializeJournal(sql);
      const applied = await readJournal(sql);
      validateJournal(migrations, applied);
      const latest = applied.at(-1);
      if (!latest) return { direction: "down" as const, changed: [], currentVersion: 0 };

      const migration = migrations.find(({ version }) => version === latest.version);
      if (!migration) throw new Error(`Migration ${latest.version} is unavailable for rollback`);
      await sql.unsafe(migration.downSql, [], { prepare: false });
      await sql.unsafe("DELETE FROM automata_schema_migrations WHERE version = $1", [
        latest.version,
      ]);
      return {
        direction: "down" as const,
        changed: [latest.version],
        currentVersion: applied.at(-2)?.version ?? 0,
      };
    });
  } finally {
    await client.end({ timeout: 2 });
  }
}
