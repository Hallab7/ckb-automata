import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadMigrations } from "./migrator.ts";

async function withMigrationDirectory(
  files: Readonly<Record<string, string>>,
  run: (directory: URL) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "automata-migrations-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, contents]) => writeFile(join(directory, name), contents)),
    );
    await run(new URL(`file:///${directory.replaceAll("\\", "/")}/`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loads paired migrations in numeric order with stable checksums", async () => {
  await withMigrationDirectory(
    {
      "0002_second.down.sql": "DROP TABLE second;",
      "0001_first.up.sql": "CREATE TABLE first (id integer);",
      "0002_second.up.sql": "CREATE TABLE second (id integer);",
      "0001_first.down.sql": "DROP TABLE first;",
      "notes.md": "ignored",
    },
    async (directory) => {
      const first = await loadMigrations(directory);
      const second = await loadMigrations(directory);
      assert.deepEqual(
        first.map(({ version, name }) => ({ version, name })),
        [
          { version: 1, name: "first" },
          { version: 2, name: "second" },
        ],
      );
      assert.match(first[0]?.checksum ?? "", /^[0-9a-f]{64}$/);
      assert.equal(first[0]?.checksum, second[0]?.checksum);
      await writeFile(
        join(fileURLToPath(directory), "0001_first.down.sql"),
        "DROP TABLE first CASCADE;",
      );
      const rollbackChanged = await loadMigrations(directory);
      assert.notEqual(first[0]?.checksum, rollbackChanged[0]?.checksum);
    },
  );
});

test("rejects gaps and unpaired migration files", async () => {
  await withMigrationDirectory(
    {
      "0002_second.up.sql": "SELECT 1;",
      "0002_second.down.sql": "SELECT 1;",
    },
    async (directory) => {
      await assert.rejects(loadMigrations(directory), /contiguous from 0001/);
    },
  );

  await withMigrationDirectory({ "0001_first.up.sql": "SELECT 1;" }, async (directory) => {
    await assert.rejects(loadMigrations(directory), /matching up and down SQL/);
  });
});

test("application startup has no migration or schema mutation path", async () => {
  const sourceDirectory = new URL("../", import.meta.url);
  const startupSources = await Promise.all(
    ["main.ts", "bootstrap.ts", "app.module.ts"].map((name) =>
      readFile(new URL(name, sourceDirectory), "utf8"),
    ),
  );
  const combined = startupSources.join("\n");
  assert.doesNotMatch(combined, /database\/migrator|migrateDatabase|rollbackDatabase/);
  assert.doesNotMatch(combined, /CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE/i);
});
