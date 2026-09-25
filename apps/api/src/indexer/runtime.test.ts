import assert from "node:assert/strict";
import test from "node:test";

import type { RegisteredDeployment } from "@ckb-automata/core";

import { LiveIndexerRuntime, nextIndexerScanRange } from "./runtime.ts";

test("an empty index backfills a bounded window in stable batches", () => {
  assert.deepEqual(nextIndexerScanRange(undefined, 1_000n), { first: 745n, last: 776n });
  assert.deepEqual(nextIndexerScanRange(999n, 1_000n), { first: 1_000n, last: 1_000n });
  assert.equal(nextIndexerScanRange(1_000n, 1_000n), undefined);
  assert.deepEqual(nextIndexerScanRange(undefined, 10n), { first: 0n, last: 10n });
});

test("runtime scans sequential canonical blocks and reports whether it caught up", async () => {
  const scanned: bigint[] = [];
  const logs: Readonly<Record<string, unknown>>[] = [];
  const runtime = new LiveIndexerRuntime(
    { getTipHeader: async () => ({ number: 100n }) } as never,
    { load: async () => ({ blockNumber: 95n }) } as never,
    {
      scanBlock: async (block: bigint) => {
        scanned.push(block);
      },
    } as never,
    {
      error: () => undefined,
      info: (_event, _message, fields = {}) => logs.push(fields),
    },
    {
      enabled: true,
      loadDeployment: async () => ({ network: "ckb_testnet" }) as RegisteredDeployment,
    },
  );

  assert.deepEqual(await runtime.runBatch(), { caughtUp: true, scanned: 5 });
  assert.deepEqual(scanned, [96n, 97n, 98n, 99n, 100n]);
  assert.equal(logs[0]?.["lastBlock"], "100");
});

test("runtime leaves the chain untouched when the checkpoint is current", async () => {
  const runtime = new LiveIndexerRuntime(
    { getTipHeader: async () => ({ number: 100n }) } as never,
    { load: async () => ({ blockNumber: 100n }) } as never,
    { scanBlock: async () => assert.fail("must not scan") } as never,
    { error: () => undefined, info: () => undefined },
    {
      enabled: true,
      loadDeployment: async () => ({ network: "ckb_testnet" }) as RegisteredDeployment,
    },
  );
  assert.deepEqual(await runtime.runBatch(), { caughtUp: true, scanned: 0 });
});

test("explicit and lifecycle startup share one idempotent scanner", () => {
  const events: string[] = [];
  const runtime = new LiveIndexerRuntime(
    { getTipHeader: async () => ({ number: 100n }) } as never,
    { load: async () => ({ blockNumber: 100n }) } as never,
    { scanBlock: async () => assert.fail("shutdown must cancel the scheduled scan") } as never,
    {
      error: () => undefined,
      info: (event) => events.push(event),
    },
    {
      enabled: true,
      loadDeployment: async () => ({ network: "ckb_testnet" }) as RegisteredDeployment,
    },
  );

  runtime.start();
  runtime.onApplicationBootstrap();
  runtime.onApplicationShutdown();

  assert.deepEqual(events, ["indexer.runtime.started"]);
});

test("polling logs the stable checkpoint failure code without sensitive details", async () => {
  const errors: Readonly<Record<string, unknown>>[] = [];
  const runtime = new LiveIndexerRuntime(
    { getTipHeader: async () => ({ number: 100n }) } as never,
    { load: async () => ({ blockNumber: 99n }) } as never,
    {
      scanBlock: async () => {
        const { CheckpointError } = await import("./checkpoints.ts");
        throw new CheckpointError(
          "REORG_BEYOND_WINDOW",
          "postgresql://user:secret@database.internal/private",
        );
      },
    } as never,
    {
      error: (_event, _message, fields = {}) => errors.push(fields),
      info: () => undefined,
    },
    {
      enabled: true,
      loadDeployment: async () => ({ network: "ckb_testnet" }) as RegisteredDeployment,
      pollIntervalMs: 1,
    },
  );

  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  runtime.onApplicationShutdown();

  assert.ok(errors.length > 0);
  assert.deepEqual(errors[0], { code: "REORG_BEYOND_WINDOW" });
  assert.doesNotMatch(JSON.stringify(errors), /secret|database\.internal/);
});
