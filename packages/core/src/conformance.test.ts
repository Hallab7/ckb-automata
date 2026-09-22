import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deploymentRegistry, validateSdkConformanceFixture } from "./index.ts";

const fixtureUrl = new URL("../../../contracts/fixtures/sdk_conformance_v1.json", import.meta.url);

async function load() {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const deployment = await deploymentRegistry.load(genesisHash);
  assert.equal(deployment.status, "ok");
  if (deployment.status !== "ok") throw new Error("local deployment unavailable");
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown;
  return { deployment: deployment.deployment, fixture };
}

test("SDK conformance covers valid and invalid JSON, binaries, and transactions", async () => {
  const { deployment, fixture } = await load();
  const result = validateSdkConformanceFixture(fixture, deployment);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(
    result.cases.map(({ id }) => id),
    [
      "recurring-creation-valid",
      "deadline-creation-valid",
      "json-sequence-mismatch",
      "unsupported-job-version",
      "truncated-deadline-transaction",
    ],
  );
});

test("SDK conformance fails closed when an expectation drifts", async () => {
  const { deployment, fixture } = await load();
  const changed = structuredClone(fixture) as {
    cases: { expected: { transaction_valid: boolean } }[];
  };
  changed.cases[0]!.expected.transaction_valid = false;
  const result = validateSdkConformanceFixture(changed, deployment);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") {
    assert.ok(result.issues.some((issue) => issue.includes("transaction expectation drifted")));
  }
});
