import assert from "node:assert/strict";
import test from "node:test";

import { parseHash32 } from "@ckb-automata/core";

import { createExecutorApplication } from "./bootstrap.ts";

const GENESIS_HASH = parseHash32(`0x${"1".repeat(64)}`);

function environment(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return {
    AUTOMATA_PROFILE: "test",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: GENESIS_HASH,
    CKB_RPC_URL: "http://127.0.0.1:8114",
    CKB_INDEXER_URL: "http://127.0.0.1:8116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
    ...overrides,
  };
}

function chainFixture(genesisHash = GENESIS_HASH) {
  let closes = 0;
  return {
    client: {
      async getGenesisHash() {
        return genesisHash;
      },
      async close() {
        closes += 1;
      },
    },
    closes: () => closes,
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

test("standalone context reports readiness without creating an HTTP listener", async () => {
  const chain = chainFixture();
  const lines: string[] = [];
  const result = await createExecutorApplication(environment(), {
    createChainClient: () => chain.client,
    writer: (line) => lines.push(line),
  });
  try {
    assert.equal("listen" in result.app, false);
    assert.deepEqual(result.runtime.readiness(), {
      status: "ready",
      network: "ckb_dev",
      activeWork: 0,
      adapters: ["deadline-v1", "recurring-v1"],
      chain: { status: "up", genesisHash: GENESIS_HASH },
    });
    assert.equal(
      lines.some((line) => line.includes('"event":"executor.ready"')),
      true,
    );
  } finally {
    await result.app.close();
  }
  assert.equal(chain.closes(), 1);
});

test("shutdown rejects new work and waits for active work before closing the chain", async () => {
  const chain = chainFixture();
  const result = await createExecutorApplication(environment(), {
    createChainClient: () => chain.client,
    writer: () => undefined,
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = result.runtime.run(async () => {
    await gate;
    return "complete";
  });
  const closing = result.app.close();
  await until(() => result.runtime.readiness().status === "draining");
  assert.equal(result.runtime.readiness().activeWork, 1);
  assert.equal(chain.closes(), 0);
  await assert.rejects(
    result.runtime.run(async () => "late"),
    /not accepting work/,
  );
  release?.();
  assert.equal(await work, "complete");
  await closing;
  assert.equal(chain.closes(), 1);
  assert.equal(result.runtime.readiness().status, "stopped");
});

test("invalid configuration prevents context creation", async () => {
  let creations = 0;
  await assert.rejects(
    createExecutorApplication(environment({ CKB_GENESIS_HASH: "invalid" }), {
      createApplicationContext: async () => {
        creations += 1;
        throw new Error("context must not be created");
      },
    }),
  );
  assert.equal(creations, 0);
});

test("wrong-network readiness fails closed and disposes the chain", async () => {
  const chain = chainFixture(parseHash32(`0x${"2".repeat(64)}`));
  await assert.rejects(
    createExecutorApplication(environment(), {
      createChainClient: () => chain.client,
      writer: () => undefined,
    }),
    /wrong network/,
  );
  assert.equal(chain.closes(), 1);
});
