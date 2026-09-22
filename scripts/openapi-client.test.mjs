import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const outputs = [
  new URL("../packages/api-client/openapi.json", import.meta.url),
  new URL("../packages/api-client/src/generated/openapi.ts", import.meta.url),
];

async function readOutputs() {
  return Promise.all(outputs.map((url) => readFile(url, "utf8")));
}

test("OpenAPI regeneration is deterministic and committed", async () => {
  const before = await readOutputs();
  execFileSync(process.execPath, ["scripts/generate-openapi-client.mjs"], {
    cwd: root,
    stdio: "pipe",
  });
  const first = await readOutputs();
  execFileSync(process.execPath, ["scripts/generate-openapi-client.mjs"], {
    cwd: root,
    stdio: "pipe",
  });
  const second = await readOutputs();

  assert.deepEqual(first, before, "committed OpenAPI artifacts were stale");
  assert.deepEqual(second, first, "OpenAPI regeneration changed output");
});
