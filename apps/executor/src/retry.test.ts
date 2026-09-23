import assert from "node:assert/strict";
import test from "node:test";

import { UnrecoverableError } from "bullmq";

import { ERROR_CATALOG } from "@ckb-automata/core";

import {
  EXECUTOR_RETRY_POLICIES,
  executeWithRetryPolicy,
  executorFailureCode,
  normalizeExecutorFailureCode,
  retryPolicyFor,
  type RetryCategory,
} from "./retry.ts";

const executorCodes = Object.entries(ERROR_CATALOG)
  .filter(([, definition]) => definition.domain === "executor")
  .map(([code]) => code)
  .toSorted();

test("every stable executor failure has exactly one bounded retry policy", () => {
  assert.deepEqual(Object.keys(EXECUTOR_RETRY_POLICIES).toSorted(), executorCodes);
  const categories = new Set<RetryCategory>();
  for (const code of executorCodes) {
    const policy = EXECUTOR_RETRY_POLICIES[code as keyof typeof EXECUTOR_RETRY_POLICIES];
    categories.add(policy.category);
    assert.equal(Number.isSafeInteger(policy.maxAttempts), true, code);
    assert.equal(policy.maxAttempts >= 1 && policy.maxAttempts <= 12, true, code);
    assert.equal(policy.retryable ? policy.maxAttempts > 1 : policy.maxAttempts === 1, true, code);
  }
  assert.deepEqual([...categories].toSorted(), [
    "cancelled",
    "consumed-by-other",
    "expired",
    "recovery-required",
    "retryable",
    "terminal-invalid",
    "unsupported",
  ]);
});

test("adapter-local failures normalize to stable executor codes", () => {
  assert.equal(
    normalizeExecutorFailureCode("INVALID_COMMITMENT"),
    "EXECUTOR_PAYLOAD_HASH_MISMATCH",
  );
  assert.equal(
    normalizeExecutorFailureCode("UNSUPPORTED_POLICY"),
    "EXECUTOR_POLICY_VERSION_UNSUPPORTED",
  );
  assert.equal(normalizeExecutorFailureCode("NOT_A_FAILURE_CODE"), undefined);
});

test("failure extraction follows bounded causes and rejects non-executor codes", () => {
  const nested = Object.assign(new Error("outer"), {
    cause: Object.assign(new Error("inner"), { code: "EXECUTOR_CHAIN_SNAPSHOT_MOVED" }),
  });
  assert.equal(executorFailureCode(nested), "EXECUTOR_CHAIN_SNAPSHOT_MOVED");
  assert.equal(retryPolicyFor(nested)?.category, "retryable");
  assert.equal(executorFailureCode({ code: "API_INTERNAL_FAILURE" }), undefined);
});

test("permanent failures stop after one processor invocation", async () => {
  const original = Object.assign(new Error("bad record"), {
    code: "EXECUTOR_BUILD_RECORD_INVALID",
  });
  await assert.rejects(
    executeWithRetryPolicy(async () => Promise.reject(original)),
    (error: unknown) => {
      assert.ok(error instanceof UnrecoverableError);
      assert.equal(error.message, "EXECUTOR_BUILD_RECORD_INVALID");
      assert.equal(error.cause, original);
      return true;
    },
  );
});

test("retryable failures retain their cause until the bounded final attempt", async () => {
  const original = Object.assign(new Error("chain moved"), {
    code: "EXECUTOR_CHAIN_SNAPSHOT_MOVED",
  });
  await assert.rejects(
    executeWithRetryPolicy(async () => Promise.reject(original), 0),
    original,
  );
  await assert.rejects(
    executeWithRetryPolicy(async () => Promise.reject(original), 11),
    (error: unknown) =>
      error instanceof UnrecoverableError && error.message === "EXECUTOR_CHAIN_SNAPSHOT_MOVED",
  );
});

test("unknown infrastructure failures remain governed by the queue retry bound", async () => {
  const original = new Error("database unavailable");
  await assert.rejects(
    executeWithRetryPolicy(async () => Promise.reject(original)),
    original,
  );
  await assert.rejects(() => executeWithRetryPolicy(async () => undefined, -1), /attempt count/);
});
