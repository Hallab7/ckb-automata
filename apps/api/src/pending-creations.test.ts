import assert from "node:assert/strict";
import test from "node:test";

import { PendingCreationService } from "./pending-creations.ts";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const metadata = Object.freeze({
  jobId: HASH_A,
  notBefore: "500",
  ownerLockHash: HASH_B,
  recipientAmount: Object.freeze({ perExecution: "10000000000", total: "30000000000" }),
  remainingRuns: "3",
  template: "recurring" as const,
});

test("registered creations are validated and persisted as submitted attempts", async () => {
  const calls: string[] = [];
  let inserted: Record<string, unknown> | undefined;
  const database = {
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          inserted = value;
        },
      }),
    }),
  };
  const transactions = {
    creationMetadata: async () => {
      calls.push("metadata");
      return metadata;
    },
    validate: async () => {
      calls.push("validate");
      return { valid: true };
    },
  };
  const service = new PendingCreationService(
    database as never,
    "ckb_testnet",
    transactions as never,
    {} as never,
  );
  const result = await service.register({
    intentHash: "33".repeat(32),
    operation: "create_recurring_job",
    policyCriticalHash: "44".repeat(32),
    request: {},
    reviewContext: {},
    transaction: {},
    transactionHash: HASH_B,
  });

  assert.deepEqual(calls, ["validate", "metadata"]);
  assert.equal(inserted?.["networkId"], "ckb_testnet");
  assert.equal(inserted?.["operation"], "create");
  assert.equal(inserted?.["state"], "submitted");
  assert.equal(inserted?.["txHash"], HASH_B);
  assert.equal(result.status, "submitting");
  assert.equal(result.jobId, HASH_A);
});

test("pending creations follow canonical progress and disappear after indexing", async () => {
  const submittedAt = new Date("2026-09-28T00:00:00.000Z");
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    networkId: "ckb_testnet",
    operation: "create",
    simulation: { kind: "pending_creation", ...metadata },
    state: "submitted",
    submittedAt,
    txHash: HASH_B,
  };
  const updates: Record<string, unknown>[] = [];
  const database = {
    select: () => {
      const builder = {
        from: () => builder,
        where: () => builder,
        orderBy: async () => [row],
      };
      return builder;
    },
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => updates.push(value),
      }),
    }),
  };
  let progressReads = 0;
  const progress = {
    read: async () => {
      progressReads += 1;
      return {
        block: { hash: HASH_A, number: "450" },
        confirmations: "8",
        observedAt: "2026-09-28T00:01:00.000Z",
        reason: null,
        requiredConfirmations: 24,
        state: "committed",
        transactionHash: HASH_B,
      };
    },
  };
  const service = new PendingCreationService(
    database as never,
    "ckb_testnet",
    {} as never,
    progress as never,
  );
  const pending = await service.list({ indexedJobIds: new Set() });
  assert.equal(pending[0]?.status, "confirming");
  assert.equal(pending[0]?.confirmations, "8");
  assert.equal(updates[0]?.["state"], "committed");

  const indexed = await service.list({ indexedJobIds: new Set([HASH_A]) });
  assert.deepEqual(indexed, []);
  assert.equal(progressReads, 1);
});
