import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("V3 owner review and detail keep the testnet and timing disclosures visible", async () => {
  const source = await readFile(new URL("./dao-harvest-v3-detail.tsx", import.meta.url), "utf8");
  assert.match(source, /NERVDAO_HARVEST_TESTNET_NOTICE/);
  assert.match(source, /NERVDAO_HARVEST_TIMING_NOTICES/);
});
