import assert from "node:assert/strict";
import test from "node:test";

import { ServiceUnavailableException } from "@nestjs/common";

import {
  HEALTH_DEPENDENCIES,
  HealthController,
  HealthService,
  type HealthDependencyName,
  type HealthProbe,
} from "./health.ts";

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
