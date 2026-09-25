import assert from "node:assert/strict";
import test from "node:test";

import { parseHash32 } from "@ckb-automata/core";

import {
  ExecutorLogger,
  createExecutorApplication,
  executorQueuePrefix,
  startExecutor,
} from "./bootstrap.ts";
import { parseEnvironment } from "@ckb-automata/config";

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
      async dryRun() {
        throw new Error("dry run is not used by bootstrap tests");
      },
      async send() {
        throw new Error("submission is not used by bootstrap tests");
      },
      async getTipHeader() {
        throw new Error("tip header is not used by bootstrap tests");
      },
      async getCellLive() {
        throw new Error("live cells are not used by bootstrap tests");
      },
      async findCellsPaged() {
        throw new Error("cell discovery is not used by bootstrap tests");
      },
      async getTransactionStatus() {
        throw new Error("transactions are not used by bootstrap tests");
      },
      async close() {
        closes += 1;
      },
    },
    closes: () => closes,
  };
}

const readyQueues = Object.freeze({
  async ready() {},
});

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
    enableConfirmationWorkers: false,
    enableEligibilityWorkers: false,
    queues: readyQueues,
    writer: (line) => lines.push(line),
  });
  try {
    assert.equal("listen" in result.app, false);
    assert.deepEqual(result.runtime.readiness(), {
      status: "ready",
      instanceId: "executor-local",
      network: "ckb_dev",
      activeWork: 0,
      adapters: ["deadline-v1", "recurring-v1"],
      chain: { status: "up", genesisHash: GENESIS_HASH },
      redis: { status: "up" },
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

test("public operators derive isolated durable queue namespaces", () => {
  assert.equal(
    executorQueuePrefix(parseEnvironment(environment({ EXECUTOR_INSTANCE_ID: "operator-a" }))),
    "ckb-automata-operator-a",
  );
  const underscored = executorQueuePrefix(
    parseEnvironment(environment({ EXECUTOR_INSTANCE_ID: "operator_a" })),
  );
  const long = executorQueuePrefix(
    parseEnvironment(environment({ EXECUTOR_INSTANCE_ID: "operator-abcdefghijklmnopqrstuvwxyz" })),
  );
  assert.match(underscored ?? "", /^[a-z][a-z0-9-]{2,47}$/);
  assert.match(long ?? "", /^[a-z][a-z0-9-]{2,47}$/);
  assert.notEqual(underscored, "ckb-automata-operator-a");
  assert.equal(executorQueuePrefix(parseEnvironment(environment())), undefined);
});

test("deployed entrypoint exposes instance-bound health", async () => {
  const chain = chainFixture();
  const result = await startExecutor(
    environment({
      PORT: "45182",
      EXECUTOR_INSTANCE_ID: "operator-a",
      EXECUTOR_LOCK_ARGS: `0x${"12".repeat(20)}`,
      EXECUTOR_TRANSACTION_FEE: "1000000",
      EXECUTOR_FEE_PRIVATE_KEY: `0x${"01".repeat(32)}`,
      EXECUTOR_MAX_CYCLES: "10000000",
      EXECUTOR_MIN_MARGIN: "1000000",
    }),
    {
      createChainClient: () => chain.client,
      enableBuildWorkers: false,
      enableConfirmationWorkers: false,
      enableEligibilityWorkers: false,
      enableSimulationWorkers: false,
      queues: readyQueues,
      writer: () => undefined,
    },
  );
  try {
    const response = await fetch("http://127.0.0.1:45182/health/ready");
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { instanceId: string }).instanceId, "operator-a");
  } finally {
    await result.healthServer?.close();
    await result.app.close();
  }
});

test("shutdown rejects new work and waits for active work before closing the chain", async () => {
  const chain = chainFixture();
  const result = await createExecutorApplication(environment(), {
    createChainClient: () => chain.client,
    enableConfirmationWorkers: false,
    enableEligibilityWorkers: false,
    queues: readyQueues,
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

test("executor fee signing material is redacted from structured and free-form logs", () => {
  const privateKey = `0x${"01".repeat(32)}`;
  const lines: string[] = [];
  const logger = new ExecutorLogger(
    parseEnvironment(environment({ EXECUTOR_FEE_PRIVATE_KEY: privateKey })),
    (line) => lines.push(line),
  );
  logger.info("executor.test", `configured ${privateKey}`, {
    executorFeePrivateKey: privateKey,
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes(privateKey), false);
  assert.equal(lines[0]?.includes("[REDACTED]"), true);
});

test("the production entrypoint requires public fee-cell configuration", async () => {
  await assert.rejects(
    startExecutor(environment(), {
      createApplicationContext: async () => {
        throw new Error("application context must not be created");
      },
      writer: () => undefined,
    }),
    /build worker configuration is required/,
  );
});

test("wrong-network readiness fails closed and disposes the chain", async () => {
  const chain = chainFixture(parseHash32(`0x${"2".repeat(64)}`));
  await assert.rejects(
    createExecutorApplication(environment(), {
      createChainClient: () => chain.client,
      enableConfirmationWorkers: false,
      enableEligibilityWorkers: false,
      queues: readyQueues,
      writer: () => undefined,
    }),
    /wrong network/,
  );
  assert.equal(chain.closes(), 1);
});

test("Redis readiness failure prevents work and disposes the chain", async () => {
  const chain = chainFixture();
  await assert.rejects(
    createExecutorApplication(environment(), {
      createChainClient: () => chain.client,
      enableConfirmationWorkers: false,
      enableEligibilityWorkers: false,
      queues: {
        async ready() {
          throw new Error("Redis unavailable");
        },
      },
      writer: () => undefined,
    }),
    /Redis unavailable/,
  );
  assert.equal(chain.closes(), 1);
});
