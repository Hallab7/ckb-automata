import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the package manager and Node engine are exact", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

  assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.match(manifest.engines.node, /^\d+\.\d+\.\d+$/);
});

test("the controlled CI failure is observable", () => {
  assert.notEqual(process.env.AUTOMATA_CI_BREAK, "1", "controlled CI failure requested");
});
