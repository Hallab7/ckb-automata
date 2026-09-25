import assert from "node:assert/strict";
import test from "node:test";

import { verifyPublicRuntime } from "./verify-public-runtime.mjs";

const environment = Object.freeze({
  PUBLIC_API_URL: "https://api.example.test/",
  EXECUTOR_A_URL: "https://executor-a.example.test/",
  EXECUTOR_B_URL: "https://executor-b.example.test/",
});

function response(body, status = 200) {
  return Object.freeze({ status, json: async () => body });
}

function readyApi() {
  return response({
    status: "ready",
    dependencies: Object.fromEntries(
      ["postgres", "redis", "rpc", "deployment", "indexLag"].map((name) => [
        name,
        { status: "up" },
      ]),
    ),
  });
}

function readyExecutor(instanceId) {
  return response({
    status: "ready",
    instanceId,
    network: "ckb_testnet",
    adapters: ["recurring-v1", "deadline-v1"],
    chain: {
      genesisHash: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
    },
    redis: { status: "up" },
  });
}

test("public runtime verification binds both independent operator identities", async () => {
  const report = await verifyPublicRuntime(environment, {
    fetchImpl: async (url) => {
      if (url.hostname === "api.example.test") return readyApi();
      return readyExecutor(
        url.hostname === "executor-a.example.test" ? "operator-a" : "operator-b",
      );
    },
  });
  assert.deepEqual(
    report.checks.map(({ name, status }) => ({ name, status })),
    [
      { name: "api", status: "ready" },
      { name: "operator-a", status: "ready" },
      { name: "operator-b", status: "ready" },
    ],
  );
});

test("public runtime verification fails closed on an operator identity mismatch", async () => {
  await assert.rejects(
    verifyPublicRuntime(environment, {
      fetchImpl: async (url) => {
        if (url.hostname === "api.example.test") return readyApi();
        return readyExecutor("operator-a");
      },
    }),
    /operator-b identity does not match/,
  );
});
