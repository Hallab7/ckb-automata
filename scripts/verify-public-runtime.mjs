/* global AbortSignal, fetch */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXPECTED_GENESIS = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
const EXPECTED_ADAPTERS = Object.freeze(["deadline-v1", "recurring-v1"]);

function endpoint(value, name, path) {
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  assert.equal(url.protocol, "https:", `${name} must use TLS`);
  assert.equal(url.pathname, "/", `${name} must be an origin`);
  url.pathname = path;
  return url;
}

async function requestJson(fetchImpl, target, name) {
  const startedAt = Date.now();
  const response = await fetchImpl(target, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(90_000),
  });
  const latencyMs = Date.now() - startedAt;
  assert.equal(response.status, 200, `${name} returned ${response.status}`);
  return Object.freeze({ body: await response.json(), latencyMs });
}

export async function verifyPublicRuntime(environment, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const targets = Object.freeze([
    Object.freeze({
      kind: "api",
      name: "api",
      url: endpoint(environment.PUBLIC_API_URL, "PUBLIC_API_URL", "/v1/health/ready"),
    }),
    Object.freeze({
      kind: "executor",
      name: "operator-a",
      url: endpoint(environment.EXECUTOR_A_URL, "EXECUTOR_A_URL", "/health/ready"),
    }),
    Object.freeze({
      kind: "executor",
      name: "operator-b",
      url: endpoint(environment.EXECUTOR_B_URL, "EXECUTOR_B_URL", "/health/ready"),
    }),
  ]);
  const checks = await Promise.all(
    targets.map(async (target) => {
      const result = await requestJson(fetchImpl, target.url, target.name);
      if (target.kind === "api") {
        assert.equal(result.body.status, "ready", "public API is not ready");
        for (const dependency of ["postgres", "redis", "rpc", "deployment", "indexLag"]) {
          assert.equal(
            result.body.dependencies?.[dependency]?.status,
            "up",
            `API dependency ${dependency} is not ready`,
          );
        }
      } else {
        assert.equal(result.body.status, "ready", `${target.name} is not ready`);
        assert.equal(result.body.instanceId, target.name, `${target.name} identity does not match`);
        assert.equal(result.body.network, "ckb_testnet", `${target.name} network does not match`);
        assert.equal(
          result.body.chain?.genesisHash,
          EXPECTED_GENESIS,
          `${target.name} genesis does not match`,
        );
        assert.deepEqual(
          [...(result.body.adapters ?? [])].toSorted(),
          [...EXPECTED_ADAPTERS],
          `${target.name} adapters do not match`,
        );
        assert.equal(result.body.redis?.status, "up", `${target.name} Redis is not ready`);
      }
      return Object.freeze({
        name: target.name,
        status: "ready",
        latencyMs: result.latencyMs,
      });
    }),
  );
  return Object.freeze({ checkedAt: new Date().toISOString(), checks: Object.freeze(checks) });
}

async function main() {
  const evidencePath = process.env.PUBLIC_RUNTIME_EVIDENCE_PATH;
  try {
    const report = await verifyPublicRuntime(process.env);
    if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      `Public runtime ready: ${report.checks.map(({ name, latencyMs }) => `${name}=${latencyMs}ms`).join(", ")}`,
    );
  } catch (error) {
    const failure = Object.freeze({
      checkedAt: new Date().toISOString(),
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown public runtime failure",
    });
    if (evidencePath)
      await writeFile(evidencePath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
