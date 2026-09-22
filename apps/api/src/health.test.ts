import assert from "node:assert/strict";
import test from "node:test";

import { ServiceUnavailableException } from "@nestjs/common";
import type { ClientBlockHeader } from "@ckb-ccc/shell";

import { parseBlockNumber, parseHash32 } from "@ckb-automata/core";

import {
  HEALTH_DEPENDENCIES,
  HealthController,
  HealthService,
  createDefaultHealthProbes,
  type HealthDependencyName,
  type HealthProbe,
} from "./health.ts";

const GENESIS_HASH = "0x5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3";
const TIP_HASH = `0x${"22".repeat(32)}`;

function probes(failing?: HealthDependencyName): readonly HealthProbe[] {
  return HEALTH_DEPENDENCIES.map((name) => ({
    name,
    async check() {
      if (name === failing) {
        throw new Error(
          "postgresql://user:secret@database.internal/private redis://:secret@redis.internal",
        );
      }
      return name === "indexLag" ? { lagBlocks: "2", maximumLagBlocks: "12" } : undefined;
    },
  }));
}

test("liveness remains healthy for every dependency failure", async () => {
  for (const dependency of HEALTH_DEPENDENCIES) {
    const service = new HealthService(probes(dependency));
    assert.equal(service.liveness().status, "ok");
    const readiness = await service.readiness();
    assert.equal(readiness.status, "not_ready");
    assert.equal(readiness.dependencies[dependency].status, "down");
    assert.equal(
      HEALTH_DEPENDENCIES.filter((name) => readiness.dependencies[name].status === "down").length,
      1,
    );
    const serialized = JSON.stringify(readiness);
    assert.doesNotMatch(serialized, /secret|database\.internal|redis\.internal/);
  }
});

test("readiness reports every dependency and preserves non-sensitive evidence", async () => {
  const report = await new HealthService(probes()).readiness();
  assert.equal(report.status, "ready");
  assert.deepEqual(Object.keys(report.dependencies), [...HEALTH_DEPENDENCIES]);
  assert.deepEqual(report.dependencies.indexLag.details, {
    lagBlocks: "2",
    maximumLagBlocks: "12",
  });
  for (const dependency of HEALTH_DEPENDENCIES) {
    assert.equal(report.dependencies[dependency].status, "up");
    assert.ok(report.dependencies[dependency].latencyMs >= 0);
  }
});

test("readiness controller maps dependency outages to HTTP 503", async () => {
  const healthy = new HealthController(new HealthService(probes()));
  assert.equal((await healthy.ready()).status, "ready");

  const unavailable = new HealthController(new HealthService(probes("redis")));
  await assert.rejects(
    unavailable.ready(),
    (error: unknown) =>
      error instanceof ServiceUnavailableException &&
      error.getStatus() === 503 &&
      (error.getResponse() as { status: string }).status === "not_ready",
  );
  assert.equal(unavailable.live().status, "ok");
});

test("health service rejects incomplete and duplicate probe sets", () => {
  assert.throws(() => new HealthService(probes().slice(1)), /every dependency exactly once/);
  assert.throws(
    () => new HealthService([...probes(), probes()[0]!]),
    /every dependency exactly once/,
  );
});

test("default chain probes consume only the shared CKB client", async () => {
  const defaultProbes = createDefaultHealthProbes(
    {
      DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
      REDIS_URL: "redis://127.0.0.1:56379",
      CKB_GENESIS_HASH: GENESIS_HASH,
    },
    {
      getGenesisHash: async () => parseHash32(GENESIS_HASH),
      getTipHeader: async () => ({ number: 42n, hash: TIP_HASH }) as ClientBlockHeader,
      getIndexerTip: async () => ({
        blockNumber: parseBlockNumber("40"),
        blockHash: parseHash32(TIP_HASH),
      }),
    },
  );
  const rpc = defaultProbes.find(({ name }) => name === "rpc");
  const deployment = defaultProbes.find(({ name }) => name === "deployment");
  const indexLag = defaultProbes.find(({ name }) => name === "indexLag");
  assert.ok(rpc && deployment && indexLag);
  assert.deepEqual(await rpc.check(), { blockNumber: "42" });
  assert.deepEqual(await deployment.check(), {
    manifestSha256: "2904b44ffa3c1f292404540f2bc6c14dc96789f888e28aa7fc2527566110e1d1",
  });
  assert.deepEqual(await indexLag.check(), { lagBlocks: "2", maximumLagBlocks: "12" });
});
