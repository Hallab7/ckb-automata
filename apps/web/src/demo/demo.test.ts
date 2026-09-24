import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { DEMO_SCENARIOS } from "./demo-data.ts";

test("guided demo scenarios are deterministic and explicitly simulated", () => {
  assert.deepEqual(
    DEMO_SCENARIOS.map(({ id, walkthrough }) => [id, walkthrough.length]),
    [
      ["scheduled", 3],
      ["ready", 3],
      ["recovery", 3],
    ],
  );
  assert.equal(new Set(DEMO_SCENARIOS.map(({ id }) => id)).size, DEMO_SCENARIOS.length);
  assert.ok(Object.isFrozen(DEMO_SCENARIOS));
  assert.doesNotMatch(
    JSON.stringify(DEMO_SCENARIOS),
    /explorer|pudge|testnet|transaction hash|block hash/i,
  );
});

test("demo and live product sources preserve the provider boundary", async () => {
  const productRoot = new URL("../../app/(product)/", import.meta.url);
  const entries = (await readdir(productRoot, { recursive: true })).map((entry) =>
    entry.replaceAll("\\", "/"),
  );
  const sources = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".tsx"))
      .map(async (entry) => [entry, await readFile(new URL(entry, productRoot), "utf8")] as const),
  );
  const demoPages = sources.filter(([entry]) => entry === "demo/page.tsx");
  const livePages = sources.filter(([entry]) => entry !== "demo/page.tsx");

  assert.equal(demoPages.length, 1);
  for (const [, source] of demoPages) {
    assert.match(source, /createDemoDataProvider/);
    assert.match(source, /dataLabel=\{provider\.label\}/);
    assert.doesNotMatch(source, /createLiveDataProvider/);
  }
  for (const [entry, source] of livePages) {
    assert.doesNotMatch(source, /createDemoDataProvider/, `${entry} imports demo data`);
  }

  const experience = await readFile(new URL("./demo.tsx", import.meta.url), "utf8");
  assert.match(experience, /Simulated records/);
  assert.doesNotMatch(experience, /explorer|pudge|testnet/i);
});
