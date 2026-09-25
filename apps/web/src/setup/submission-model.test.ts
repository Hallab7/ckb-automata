import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ApiTransactionBuild, ApiTransactionValidation } from "@ckb-automata/api-client";
import type { UnsignedDeadlineTransaction } from "@ckb-automata/core";

import type { CreationReviewResult } from "./creation-review.tsx";
import {
  parseSubmissionRecord,
  submitCreationReview,
  type SubmissionDependencies,
  type SubmissionRecord,
} from "./submission-model.ts";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const INTENT_HASH = "33".repeat(32);
const POLICY_HASH = "44".repeat(32);

const transaction = Object.freeze({ witnesses: ["0x"] }) as unknown as UnsignedDeadlineTransaction;
const artifact = Object.freeze({
  intentHash: INTENT_HASH,
  policyCriticalHash: POLICY_HASH,
}) as ApiTransactionBuild;
const review = Object.freeze({
  artifact,
  key: "recurring:owner:draft",
  model: Object.freeze({ transactionHash: HASH_A }),
  request: Object.freeze({ operation: "create_recurring_job", value: Object.freeze({}) }),
  transaction,
}) as unknown as CreationReviewResult;
const validation = Object.freeze({
  dryRunCycles: "100",
  intentHash: INTENT_HASH,
  operation: "create_recurring_job",
  policyCriticalHash: POLICY_HASH,
  valid: true,
}) satisfies ApiTransactionValidation;

function dependencies(overrides: Partial<SubmissionDependencies> = {}) {
  const calls: string[] = [];
  let persisted: SubmissionRecord | undefined;
  const value: SubmissionDependencies = {
    broadcast: async () => {
      calls.push("broadcast");
      return HASH_A;
    },
    now: () => "2026-09-23T12:00:00.000Z",
    persist: (record) => {
      calls.push("persist");
      persisted = record;
      return true;
    },
    readPersisted: () => undefined,
    refreshArtifact: async () => {
      calls.push("refresh");
      return artifact;
    },
    reverify: async () => {
      calls.push("reverify");
    },
    sign: async () => {
      calls.push("sign");
      return transaction;
    },
    validateSigned: async () => {
      calls.push("validate");
      return validation;
    },
    ...overrides,
  };
  return { calls, dependencies: value, persisted: () => persisted };
}

test("approved transaction is revalidated, signed, submitted, then persisted", async () => {
  const context = dependencies();
  const result = await submitCreationReview(review, context.dependencies);
  assert.deepEqual(context.calls, [
    "refresh",
    "reverify",
    "sign",
    "validate",
    "broadcast",
    "persist",
  ]);
  assert.equal(result.record.transactionHash, HASH_A);
  assert.equal(result.recovered, false);
  assert.equal(result.persisted, true);
  assert.equal(context.persisted()?.reviewedTransactionHash, HASH_A);
});

for (const message of ["The wallet rejected the request", "The wallet window was closed"]) {
  test(`${message.toLowerCase()} records no false submission`, async () => {
    const context = dependencies({ sign: async () => Promise.reject(new Error(message)) });
    await assert.rejects(submitCreationReview(review, context.dependencies), new RegExp(message));
    assert.deepEqual(context.calls, ["refresh", "reverify"]);
    assert.equal(context.persisted(), undefined);
  });
}

test("a newer canonical tip does not invalidate an unchanged reviewed artifact", async () => {
  const context = dependencies({
    refreshArtifact: async () =>
      ({ ...artifact, policyCriticalHash: "55".repeat(32) }) as ApiTransactionBuild,
  });
  await submitCreationReview(review, context.dependencies);
  assert.deepEqual(context.calls, ["reverify", "sign", "validate", "broadcast", "persist"]);
});

test("a changed quote blocks the wallet invocation", async () => {
  const context = dependencies({
    refreshArtifact: async () =>
      ({ ...artifact, quote: { maximumLockedTotal: "1" } }) as ApiTransactionBuild,
  });
  await assert.rejects(
    submitCreationReview(review, context.dependencies),
    /quote, or policy changed/,
  );
  assert.deepEqual(context.calls, []);
  assert.equal(context.persisted(), undefined);
});

test("stale input blocks the wallet invocation", async () => {
  const context = dependencies({
    reverify: async () => Promise.reject(new Error("reviewed wallet input is no longer live")),
  });
  await assert.rejects(submitCreationReview(review, context.dependencies), /no longer live/);
  assert.deepEqual(context.calls, ["refresh"]);
  assert.equal(context.persisted(), undefined);
});

test("RPC failure records no false submission", async () => {
  const context = dependencies({
    broadcast: async () => Promise.reject(new Error("RPC unavailable")),
  });
  await assert.rejects(submitCreationReview(review, context.dependencies), /RPC unavailable/);
  assert.deepEqual(context.calls, ["refresh", "reverify", "sign", "validate"]);
  assert.equal(context.persisted(), undefined);
});

test("matching persisted submission makes resubmission idempotent", async () => {
  const stored = Object.freeze({
    operation: "create_recurring_job",
    persistedAt: "2026-09-23T12:00:00.000Z",
    reviewKey: review.key,
    reviewedTransactionHash: HASH_A,
    transactionHash: HASH_A,
    version: 1,
  }) satisfies SubmissionRecord;
  const context = dependencies({ readPersisted: () => stored });
  const result = await submitCreationReview(review, context.dependencies);
  assert.equal(result.recovered, true);
  assert.deepEqual(context.calls, []);
});

test("submission records reject malformed or mismatched values", () => {
  assert.equal(parseSubmissionRecord(null), undefined);
  assert.equal(parseSubmissionRecord("{}"), undefined);
  assert.equal(
    parseSubmissionRecord(JSON.stringify({ version: 1, transactionHash: HASH_B })),
    undefined,
  );
});

test("CCC submission signs without rebuilding and checks ambiguous resubmission", async () => {
  const [provider, approval] = await Promise.all([
    readFile(new URL("../ccc/ccc-provider.tsx", import.meta.url), "utf8"),
    readFile(new URL("./creation-submission.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(provider, /currentSigner\.signOnlyTransaction\(cccTransactionLike\(transaction\)\)/);
  assert.doesNotMatch(provider, /currentSigner\.signTransaction\(/);
  assert.match(provider, /client\.getCellLive\(input\.previousOutput, true, true\)/);
  assert.match(provider, /client\.getHeaderByNumber\(snapshotBlock\)/);
  assert.match(provider, /assertCanonicalReviewWindow\(snapshot, tip\.number/);
  assert.match(provider, /currentSigner\.client\s*\.getTransaction\(expectedHash\)/);
  assert.match(approval, /window\.localStorage/);
  assert.match(approval, /api\.validateSigned/);
  assert.match(approval, /reviewContext/);
});
