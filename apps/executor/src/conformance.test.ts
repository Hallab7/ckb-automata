import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deploymentRegistry, validateSdkConformanceFixture } from "@ckb-automata/core";

const fixtureUrl = new URL("../../../contracts/fixtures/sdk_conformance_v1.json", import.meta.url);

test("executor consumes the canonical SDK conformance suite", async () => {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const deployment = await deploymentRegistry.load(genesisHash);
  assert.equal(deployment.status, "ok");
  if (deployment.status !== "ok") return;
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown;
  const result = validateSdkConformanceFixture(fixture, deployment.deployment);
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.cases.length, 5);
});
