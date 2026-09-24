import assert from "node:assert/strict";
import test from "node:test";

import type { ClientBlock, ClientBlockHeader, ClientTransactionResponse } from "@ckb-ccc/shell";

import { parseEnvironment } from "@ckb-automata/config";
import { deploymentRegistry, parseHash32, type DeploymentRegistry } from "@ckb-automata/core";

import {
  TransactionProgressService,
  TransactionProgressStreamService,
  type TransactionProgress,
  type TransactionProgressChainClient,
} from "./transaction-progress.ts";

const GENESIS_HASH = "0x5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3";
const TRANSACTION_HASH = parseHash32(`0x${"11".repeat(32)}`);
const BLOCK_HASH = `0x${"22".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"33".repeat(32)}`;
const SUBMITTED_AT = "2026-09-24T10:00:00.000Z";

function environment() {
  return parseEnvironment({
    AUTOMATA_PROFILE: "local",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: GENESIS_HASH,
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  });
}

async function registry(requiredDepth = 3): Promise<DeploymentRegistry> {
  const loaded = await deploymentRegistry.load(GENESIS_HASH);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("fixture deployment missing");
  return {
    genesisHashes: deploymentRegistry.genesisHashes,
    load: async () => ({
      status: "ok",
      deployment: {
        ...loaded.deployment,
        confirmation: { ...loaded.deployment.confirmation, requiredDepth },
      },
    }),
  };
}

function transaction(
  status: "sent" | "pending" | "proposed" | "committed" | "unknown" | "rejected",
  options: {
    readonly blockHash?: string;
    readonly blockNumber?: bigint;
    readonly reason?: string;
  } = {},
): ClientTransactionResponse {
  return {
    status,
    transaction: { hash: () => TRANSACTION_HASH },
    ...options,
  } as unknown as ClientTransactionResponse;
}

function chain(
  response: ClientTransactionResponse | undefined,
  options: { readonly canonicalHash?: string; readonly tip?: bigint } = {},
): TransactionProgressChainClient {
  const canonicalHash = options.canonicalHash ?? BLOCK_HASH;
  return {
    getTransactionStatus: async () => response,
    getTipHeader: async () =>
      ({ number: options.tip ?? 101n, hash: OTHER_BLOCK_HASH }) as ClientBlockHeader,
    getBlockByNumber: async () =>
      ({ header: { number: 100n, hash: canonicalHash } }) as ClientBlock,
  };
}

async function service(
  response: ClientTransactionResponse | undefined,
  options: {
    readonly canonicalHash?: string;
    readonly now?: string;
    readonly requiredDepth?: number;
    readonly tip?: bigint;
  } = {},
): Promise<TransactionProgressService> {
  return new TransactionProgressService(environment(), chain(response, options), {
    now: () => new Date(options.now ?? "2026-09-24T10:01:00.000Z"),
    registry: await registry(options.requiredDepth),
  });
}

const baseQuery = { submittedAt: SUBMITTED_AT } as const;

test("maps submitted, proposed, and conflicted node states without success", async () => {
  const cases = [
    ["pending", "submitted"],
    ["proposed", "proposed"],
    ["rejected", "conflicted"],
  ] as const;
  for (const [rpcState, expected] of cases) {
    const progress = await (await service(transaction(rpcState))).read(TRANSACTION_HASH, baseQuery);
    assert.equal(progress.state, expected);
    assert.equal(progress.confirmations, "0");
    assert.equal(progress.block, null);
  }
});

test("reports committed until canonical confirmation depth is reached", async () => {
  const response = transaction("committed", { blockHash: BLOCK_HASH, blockNumber: 100n });
  const committed = await (
    await service(response, { requiredDepth: 3, tip: 101n })
  ).read(TRANSACTION_HASH, baseQuery);
  const confirmed = await (
    await service(response, { requiredDepth: 3, tip: 102n })
  ).read(TRANSACTION_HASH, baseQuery);
  assert.deepEqual(
    { state: committed.state, confirmations: committed.confirmations, block: committed.block },
    {
      state: "committed",
      confirmations: "2",
      block: { number: "100", hash: BLOCK_HASH },
    },
  );
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.confirmations, "3");
});

test("reports dropped only after the propagation window", async () => {
  const early = await (
    await service(undefined, { now: "2026-09-24T10:09:59.999Z" })
  ).read(TRANSACTION_HASH, baseQuery);
  const expired = await (
    await service(undefined, { now: "2026-09-24T10:10:00.000Z" })
  ).read(TRANSACTION_HASH, baseQuery);
  assert.equal(early.state, "submitted");
  assert.equal(expired.state, "dropped");
});

test("detects an orphaned current block and a lost inclusion restored after reload", async () => {
  const response = transaction("committed", { blockHash: BLOCK_HASH, blockNumber: 100n });
  const orphaned = await (
    await service(response, { canonicalHash: OTHER_BLOCK_HASH })
  ).read(TRANSACTION_HASH, baseQuery);
  const restored = await (
    await service(undefined)
  ).read(TRANSACTION_HASH, {
    ...baseQuery,
    previousBlockNumber: "100",
    previousBlockHash: BLOCK_HASH,
  });
  assert.equal(orphaned.state, "reorged");
  assert.equal(restored.state, "reorged");
  assert.deepEqual(restored.block, { number: "100", hash: BLOCK_HASH });
});

test("detects canonical reinclusion once before advancing at the new block", async () => {
  const response = transaction("committed", { blockHash: OTHER_BLOCK_HASH, blockNumber: 101n });
  const progress = await (
    await service(response, { canonicalHash: OTHER_BLOCK_HASH, tip: 101n })
  ).read(TRANSACTION_HASH, {
    ...baseQuery,
    previousBlockNumber: "100",
    previousBlockHash: BLOCK_HASH,
  });
  assert.equal(progress.state, "reorged");
  assert.deepEqual(progress.block, { number: "101", hash: OTHER_BLOCK_HASH });
});

test("fails closed when committed provenance is incomplete", async () => {
  const progress = await service(transaction("committed"));
  await assert.rejects(
    () => progress.read(TRANSACTION_HASH, baseQuery),
    /incomplete block provenance/,
  );
});

test("rejects malformed hashes and incomplete reload context", async () => {
  const progress = await service(undefined);
  await assert.rejects(() => progress.read("0x01", baseQuery), /32-byte hash/);
  await assert.rejects(
    () => progress.read(TRANSACTION_HASH, { ...baseQuery, previousBlockNumber: "100" }),
    /provided together/,
  );
});

test("stream emits current snapshots, changes, and reconnect state", async () => {
  const snapshots: TransactionProgress[] = [
    {
      transactionHash: TRANSACTION_HASH,
      state: "submitted",
      confirmations: "0",
      requiredConfirmations: 3,
      block: null,
      observedAt: "2026-09-24T10:00:01.000Z",
      reason: null,
    },
    {
      transactionHash: TRANSACTION_HASH,
      state: "proposed",
      confirmations: "0",
      requiredConfirmations: 3,
      block: null,
      observedAt: "2026-09-24T10:00:02.000Z",
      reason: null,
    },
  ];
  let reads = 0;
  const stream = new TransactionProgressStreamService(
    { read: async () => snapshots[Math.min(reads++, snapshots.length - 1)]! },
    { heartbeatMs: 100, pollMs: 5 },
  );
  const received = await new Promise<TransactionProgress[]>((resolve, reject) => {
    const values: TransactionProgress[] = [];
    const subscription = stream.stream(TRANSACTION_HASH, baseQuery).subscribe({
      next: (frame) => {
        if (frame.data === undefined) return;
        values.push(frame.data as TransactionProgress);
        if (values.length === 2) {
          subscription.unsubscribe();
          resolve(values);
        }
      },
      error: reject,
    });
  });
  assert.deepEqual(
    received.map(({ state }) => state),
    ["submitted", "proposed"],
  );

  const reconnected = await new Promise<TransactionProgress>((resolve, reject) => {
    const subscription = stream.stream(TRANSACTION_HASH, baseQuery).subscribe({
      next: (frame) => {
        if (frame.data !== undefined) {
          subscription.unsubscribe();
          resolve(frame.data as TransactionProgress);
        }
      },
      error: reject,
    });
  });
  assert.equal(reconnected.state, "proposed");
});
