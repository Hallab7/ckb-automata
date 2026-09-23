import assert from "node:assert/strict";
import test from "node:test";

import { parseHash32 } from "@ckb-automata/core";

import {
  ConfirmationService,
  deriveConfirmationTransition,
  type ConfirmationAttempt,
  type ConfirmationEvidence,
  type ConfirmationStore,
  type ConfirmationTransition,
  type RpcTransactionObservation,
} from "./confirmation.ts";
import { ExecutorReceiptSigner } from "./receipt.ts";
import { operatorLockArgs } from "./signing.ts";

const ATTEMPT_ID = "00000000-0000-4000-8000-000000000075";
const JOB_ID = parseHash32(`0x${"74".repeat(32)}`);
const TX_HASH = parseHash32(`0x${"75".repeat(32)}`);
const BLOCK_HASH = parseHash32(`0x${"50".repeat(32)}`);
const PRIVATE_KEY = `0x${"08".repeat(32)}`;
const RECEIPTS = new ExecutorReceiptSigner({
  network: "ckb_dev",
  privateKey: PRIVATE_KEY,
  executorLock: {
    codeHash: parseHash32(`0x${"01".repeat(32)}`),
    hashType: "type",
    args: operatorLockArgs(PRIVATE_KEY),
  },
  version: "0.0.0-test",
  revision: "1234567",
});

function attempt(
  state: ConfirmationAttempt["state"] = "submitted",
  submittedAt = new Date("2026-09-23T10:00:00.000Z"),
  committedBlockNumber?: string,
): ConfirmationAttempt {
  return Object.freeze({
    attemptId: ATTEMPT_ID,
    jobId: JOB_ID,
    sequence: "4",
    transactionHash: TX_HASH,
    state,
    submittedAt,
    ...(committedBlockNumber === undefined ? {} : { committedBlockNumber }),
  });
}

function rpc(status: RpcTransactionObservation["status"]): RpcTransactionObservation {
  return Object.freeze({ status, transactionHash: TX_HASH });
}

const noEvidence = Object.freeze({ requiredDepth: 2 } satisfies ConfirmationEvidence);

test("pending, proposed, rejected, and aged unknown observations map to canonical states", () => {
  const now = new Date("2026-09-23T10:05:00.000Z");
  assert.equal(deriveConfirmationTransition(attempt(), rpc("pending"), noEvidence, now), undefined);
  assert.deepEqual(deriveConfirmationTransition(attempt(), rpc("proposed"), noEvidence, now), {
    state: "proposed",
    eventType: "transaction_proposed",
    observedStatus: "proposed",
  });
  assert.deepEqual(deriveConfirmationTransition(attempt(), rpc("rejected"), noEvidence, now), {
    state: "dropped",
    eventType: "transaction_dropped",
    observedStatus: "rejected",
    errorCode: "EXECUTOR_NODE_REJECTED",
  });
  assert.equal(
    deriveConfirmationTransition(attempt(), rpc("unknown"), noEvidence, now, 600_000),
    undefined,
  );
  assert.deepEqual(
    deriveConfirmationTransition(
      attempt(),
      undefined,
      noEvidence,
      new Date("2026-09-23T10:10:00.000Z"),
      600_000,
    ),
    {
      state: "dropped",
      eventType: "transaction_dropped",
      observedStatus: "unavailable",
      errorCode: "EXECUTOR_TX_DROPPED",
    },
  );
});

test("canonical evidence overrides temporary RPC disagreement and enforces depth", () => {
  const inclusion = Object.freeze({
    blockNumber: "100",
    blockHash: BLOCK_HASH,
    source: "indexed_event" as const,
  });
  const committed = deriveConfirmationTransition(
    attempt(),
    rpc("pending"),
    { requiredDepth: 2, checkpointBlockNumber: "100", inclusion },
    new Date(),
  );
  assert.deepEqual(committed, {
    state: "committed",
    eventType: "transaction_committed",
    observedStatus: "pending",
    block: inclusion,
    confirmations: "1",
    requiredDepth: 2,
  });
  assert.equal(
    deriveConfirmationTransition(
      attempt("committed", undefined, "100"),
      rpc("pending"),
      { requiredDepth: 2, checkpointBlockNumber: "100", inclusion },
      new Date(),
    ),
    undefined,
  );
  assert.equal(
    deriveConfirmationTransition(
      attempt("committed", undefined, "99"),
      rpc("pending"),
      { requiredDepth: 2, checkpointBlockNumber: "100", inclusion },
      new Date(),
    )?.state,
    "committed",
  );
  const confirmed = deriveConfirmationTransition(
    attempt("committed", undefined, "100"),
    rpc("pending"),
    { requiredDepth: 2, checkpointBlockNumber: "101", inclusion },
    new Date(),
  );
  assert.deepEqual(confirmed, {
    state: "confirmed",
    eventType: "transaction_confirmed",
    observedStatus: "pending",
    block: inclusion,
    confirmations: "2",
    requiredDepth: 2,
  });
});

test("a canonical competing spend conflicts the attempt before RPC status", () => {
  const conflict = Object.freeze({
    blockNumber: "100",
    blockHash: BLOCK_HASH,
    source: "indexed_event" as const,
    transactionHash: parseHash32(`0x${"76".repeat(32)}`),
    executorLockHash: parseHash32(`0x${"77".repeat(32)}`),
    successorOutPoint: Object.freeze({
      txHash: parseHash32(`0x${"78".repeat(32)}`),
      index: "2",
    }),
  });
  assert.deepEqual(
    deriveConfirmationTransition(
      attempt("proposed"),
      rpc("pending"),
      { requiredDepth: 2, checkpointBlockNumber: "100", conflict },
      new Date(),
    ),
    {
      state: "conflicted",
      eventType: "transaction_conflicted",
      observedStatus: "pending",
      errorCode: "EXECUTOR_ALREADY_CONSUMED",
      block: conflict,
      relatedTransactionHash: conflict.transactionHash,
      winningExecutorLockHash: conflict.executorLockHash,
      successorOutPoint: conflict.successorOutPoint,
    },
  );
});

test("only an orphan with its exact original input restored enters recovery", async () => {
  const originalOutPoint = Object.freeze({
    txHash: parseHash32(`0x${"73".repeat(32)}`),
    index: "0",
  });
  const orphanedBlock = Object.freeze({
    blockNumber: "100",
    blockHash: BLOCK_HASH,
    source: "orphaned_indexed_event" as const,
  });
  const unavailable = {
    requiredDepth: 2,
    reorg: { orphanedBlock, originalOutPoint, originalInputLive: false },
  } satisfies ConfirmationEvidence;
  assert.equal(
    deriveConfirmationTransition(
      attempt("committed", undefined, "100"),
      rpc("unknown"),
      unavailable,
      new Date(),
    ),
    undefined,
  );
  const restored = {
    requiredDepth: 2,
    reorg: { orphanedBlock, originalOutPoint, originalInputLive: true },
  } satisfies ConfirmationEvidence;
  assert.deepEqual(
    deriveConfirmationTransition(
      attempt("committed", undefined, "100"),
      rpc("unknown"),
      restored,
      new Date(),
    ),
    {
      state: "reorged",
      eventType: "transaction_reorged",
      observedStatus: "unknown",
      errorCode: "EXECUTOR_TX_REORGED",
      orphanedBlock,
      originalOutPoint,
    },
  );
});

class MemoryStore implements ConfirmationStore {
  current: ConfirmationAttempt | undefined = attempt();
  evidenceValue: ConfirmationEvidence = noEvidence;
  applied: ConfirmationTransition | undefined;

  async listPending() {
    return [];
  }

  async load(attemptId: string, transactionHash: string) {
    return this.current?.attemptId === attemptId && this.current.transactionHash === transactionHash
      ? this.current
      : undefined;
  }

  async evidence() {
    return this.evidenceValue;
  }

  async apply(_attempt: ConfirmationAttempt, transition: ConfirmationTransition) {
    this.applied = transition;
    return true;
  }
}

test("service rejects RPC hash drift and applies a verified proposal", async () => {
  const store = new MemoryStore();
  let returnedHash = TX_HASH;
  const service = new ConfirmationService({
    store,
    receipts: RECEIPTS,
    chain: {
      async getTransactionStatus() {
        return {
          status: "proposed",
          transaction: { hash: () => returnedHash },
        };
      },
    },
  });
  assert.deepEqual(await service.track({ attemptId: ATTEMPT_ID, transactionHash: TX_HASH }), {
    status: "transitioned",
    state: "proposed",
  });
  assert.equal(store.applied?.state, "proposed");

  returnedHash = parseHash32(`0x${"99".repeat(32)}`);
  await assert.rejects(
    service.track({ attemptId: ATTEMPT_ID, transactionHash: TX_HASH }),
    /wrong hash/,
  );
});

test("canonical evidence progresses during RPC outage without inferring a drop", async () => {
  const store = new MemoryStore();
  store.evidenceValue = {
    requiredDepth: 1,
    checkpointBlockNumber: "100",
    inclusion: {
      blockNumber: "100",
      blockHash: BLOCK_HASH,
      source: "indexed_event",
    },
  };
  const service = new ConfirmationService({
    store,
    receipts: RECEIPTS,
    now: () => new Date("2026-09-23T11:00:00.000Z"),
    dropAfterMs: 1,
    chain: {
      async getTransactionStatus() {
        throw new Error("RPC unavailable");
      },
    },
  });
  assert.deepEqual(await service.track({ attemptId: ATTEMPT_ID, transactionHash: TX_HASH }), {
    status: "transitioned",
    state: "confirmed",
  });
  assert.equal(store.applied?.observedStatus, "unavailable");

  store.evidenceValue = noEvidence;
  store.applied = undefined;
  await assert.rejects(
    service.track({ attemptId: ATTEMPT_ID, transactionHash: TX_HASH }),
    /RPC unavailable/,
  );
  assert.equal(store.applied, undefined);
});
