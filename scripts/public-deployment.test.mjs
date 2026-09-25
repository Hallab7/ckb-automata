import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const blueprint = await readFile(new URL("render.yaml", root), "utf8");
const verifier = await readFile(new URL("scripts/verify-public-api.mjs", root), "utf8");

test("public data services use explicit testnet and secret references", () => {
  for (const value of [
    "name: ckb-automata-api",
    "name: ckb-automata-redis",
    "value: testnet-public",
    "value: ckb_testnet",
    "healthCheckPath: /v1/health/live",
    "pnpm database:migrate && pnpm database:initialize-network",
    "maxmemoryPolicy: noeviction",
    "DATABASE_URL\n        sync: false",
    "property: connectionString",
  ]) {
    assert.ok(blueprint.includes(value), `render.yaml is missing ${value}`);
  }
  assert.doesNotMatch(blueprint, /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/i);
  assert.doesNotMatch(blueprint, /redis(?:s)?:\/\/[^\s]+:[^\s]+@/i);
});

test("public verification covers TLS, readiness, identity, and metrics", () => {
  for (const value of [
    'assert.equal(apiUrl.protocol, "https:"',
    'request("v1/health/ready")',
    'request("v1/network")',
    'request("v1/metrics", "text/plain")',
    "manifest.genesisHash",
  ]) {
    assert.ok(verifier.includes(value), `public verifier is missing ${value}`);
  }
});
