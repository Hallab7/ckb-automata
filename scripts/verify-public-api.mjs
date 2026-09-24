/* global fetch */

import assert from "node:assert/strict";

import manifest from "../deploy/manifests/testnet.json" with { type: "json" };

const apiUrlValue = process.env.PUBLIC_API_URL;
if (!apiUrlValue) throw new Error("PUBLIC_API_URL is required");
const apiUrl = new URL(apiUrlValue);
assert.equal(apiUrl.protocol, "https:", "public API must use TLS");
assert.equal(apiUrl.pathname, "/", "PUBLIC_API_URL must be an origin");
assert.equal(apiUrl.search, "");
assert.equal(apiUrl.hash, "");

const expectedOrigin = process.env.PUBLIC_APP_ORIGIN;

async function request(path, accept = "application/json") {
  const response = await fetch(new URL(path, apiUrl), {
    headers: {
      accept,
      ...(expectedOrigin ? { origin: expectedOrigin } : {}),
    },
  });
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
  if (expectedOrigin) {
    assert.equal(response.headers.get("access-control-allow-origin"), expectedOrigin);
  }
  return response;
}

const liveness = await (await request("v1/health/live")).json();
assert.deepEqual(
  { status: liveness.status, service: liveness.service },
  { status: "ok", service: "ckb-automata:api" },
);

const readiness = await (await request("v1/health/ready")).json();
assert.equal(readiness.status, "ready");
for (const dependency of ["postgres", "redis", "rpc", "deployment", "indexLag"]) {
  assert.equal(readiness.dependencies?.[dependency]?.status, "up", `${dependency} is not ready`);
}

const network = await (await request("v1/network")).json();
assert.equal(network.network, manifest.network);
assert.equal(network.genesisHash, manifest.genesisHash);
assert.equal(network.confirmationDepth, 24);
assert.equal(
  network.deploymentManifestHash,
  "8902af74e77e28fc10c4d73eae37a6343e788ede98cd90c7a2add2170525bf38",
);

const metrics = await (await request("v1/metrics", "text/plain")).text();
for (const metric of [
  "automata_indexer_tip_lag_blocks",
  "automata_jobs_live_total",
  "automata_rpc_errors_total",
]) {
  assert.match(metrics, new RegExp(`^# HELP ${metric} `, "m"));
}

console.log(
  `Public API verified: ${apiUrl.origin}, ${Object.keys(readiness.dependencies).length} dependencies ready`,
);
