import assert from "node:assert/strict";
import test from "node:test";

import { startExecutorHealthServer } from "./health.ts";

test("executor health listener separates liveness from dependency readiness", async () => {
  let status: "ready" | "not_ready" = "not_ready";
  const runtime = {
    readiness: () => ({
      status,
      instanceId: "operator-a",
      network: "ckb_testnet",
      activeWork: 0,
      adapters: ["deadline-v1", "recurring-v1"],
      chain: { status: status === "ready" ? "up" : "down" },
      redis: { status: status === "ready" ? "up" : "down" },
    }),
  } as never;
  const server = await startExecutorHealthServer(runtime, 45_181);
  try {
    const live = await fetch("http://127.0.0.1:45181/health/live");
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), {
      status: "ok",
      service: "ckb-automata:executor",
      instanceId: "operator-a",
      uptimeSeconds: 0,
    });

    const unavailable = await fetch("http://127.0.0.1:45181/health/ready");
    assert.equal(unavailable.status, 503);
    status = "ready";
    const ready = await fetch("http://127.0.0.1:45181/health/ready");
    assert.equal(ready.status, 200);
    assert.equal(((await ready.json()) as { instanceId: string }).instanceId, "operator-a");
  } finally {
    await server.close();
  }
});

test("executor health listener rejects invalid ports", async () => {
  await assert.rejects(startExecutorHealthServer({} as never, 0), /between 1 and 65535/);
});
