import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApiJob,
  ApiJobQuote,
  ApiTransactionBuild,
  ApiTransactionValidation,
} from "@ckb-automata/api-client";
import type { ScriptIdentity, UnsignedDeadlineTransaction } from "@ckb-automata/core";

import {
  assertOwner,
  createOwnerActionReview,
  ownerActionRequest,
  readOwnerActionRecord,
  submitOwnerAction,
  writeOwnerActionRecord,
  type SubmitOwnerActionDependencies,
} from "./owner-action-model.ts";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const INTENT_HASH = "33".repeat(32);
const POLICY_HASH = "44".repeat(32);
const ownerLock = {
  args: "0x1234",
  codeHash: HASH_B,
  hashType: "type",
} as unknown as ScriptIdentity;

const transaction = {
  cellDeps: [],
  headerDeps: [],
  inputs: [{ previousOutput: { index: "0x1", txHash: HASH_A }, since: "0x0" }],
  outputs: [],
  outputsData: [],
  version: "0x0",
  witnesses: ["0x"],
} as unknown as UnsignedDeadlineTransaction;

const quote = {
  jobId: HASH_B,
  quoteId: "55".repeat(32),
  snapshot: {
    jobOutPoint: { index: "1", txHash: HASH_A },
    tip: { blockHash: HASH_B, blockNumber: "100" },
  },
} as ApiJobQuote;

const artifact = {
  chainSnapshot: {
    jobOutPoint: quote.snapshot.jobOutPoint,
    tip: quote.snapshot.tip,
  },
  intentHash: INTENT_HASH,
  operation: "recover_job",
  policyCriticalHash: POLICY_HASH,
  quote: {},
  transaction,
} as unknown as ApiTransactionBuild;

const job = {
  jobId: HASH_B,
  ownerLockHash: HASH_B,
  source: { outPoint: quote.snapshot.jobOutPoint },
  state: "live",
} as ApiJob;

const validation = {
  dryRunCycles: "100",
  intentHash: INTENT_HASH,
  operation: "recover_job",
  policyCriticalHash: POLICY_HASH,
  valid: true,
} satisfies ApiTransactionValidation;

async function review() {
  const request = ownerActionRequest("recover", HASH_B, quote.quoteId, ownerLock, {
    reason: "terminal_operational_failure",
  });
  return createOwnerActionReview("recover", request, quote, artifact, async () => ({
    hash: HASH_A,
    transaction,
  }));
}

function dependencies(
  calls: string[],
  overrides: Partial<SubmitOwnerActionDependencies> = {},
): SubmitOwnerActionDependencies {
  return {
    broadcast: async () => {
      calls.push("broadcast");
      return HASH_A;
    },
    build: async () => {
      calls.push("build");
      return artifact;
    },
    getJob: async () => {
      calls.push("job");
      return job;
    },
    getQuote: async () => {
      calls.push("quote");
      return quote;
    },
    now: () => "2026-09-24T12:00:00.000Z",
    resolveLiveInput: async () => {
      calls.push("live-input");
      return {};
    },
    sign: async () => {
      calls.push("sign");
      return transaction;
    },
    validate: async () => {
      calls.push("validate");
      return validation;
    },
    ...overrides,
  };
}

test("owner action refreshes the job, quote, build, and inputs before signing", async () => {
  const calls: string[] = [];
  const reviewed = await review();
  assert.equal(reviewed.snapshot.expiresAfterBlock, "130");
  const result = await submitOwnerAction(reviewed, dependencies(calls));
  assert.deepEqual(calls, ["job", "quote", "build", "live-input", "sign", "validate", "broadcast"]);
  assert.equal(result.action, "recover");
  assert.equal(result.transactionHash, HASH_A);
});

test("a lost race stops before quote refresh or wallet invocation", async () => {
  const calls: string[] = [];
  await assert.rejects(
    submitOwnerAction(
      await review(),
      dependencies(calls, {
        getJob: async () => {
          calls.push("job");
          return { ...job, state: "spent" };
        },
      }),
    ),
    /Another transaction already changed/,
  );
  assert.deepEqual(calls, ["job"]);
});

test("ordinary tip advancement does not invalidate an unchanged owner action", async () => {
  const calls: string[] = [];
  const result = await submitOwnerAction(
    await review(),
    dependencies(calls, {
      getQuote: async () => {
        calls.push("quote");
        return {
          ...quote,
          snapshot: { ...quote.snapshot, tip: { ...quote.snapshot.tip, blockNumber: "101" } },
        };
      },
      build: async () => {
        calls.push("build");
        return {
          ...artifact,
          chainSnapshot: {
            ...quote.snapshot,
            tip: { ...quote.snapshot.tip, blockNumber: "101" },
          },
        };
      },
    }),
  );
  assert.equal(result.transactionHash, HASH_A);
  assert.deepEqual(calls, ["job", "quote", "build", "live-input", "sign", "validate", "broadcast"]);
});

test("a rejected signature never validates or broadcasts", async () => {
  const calls: string[] = [];
  await assert.rejects(
    submitOwnerAction(
      await review(),
      dependencies(calls, {
        sign: async () => {
          calls.push("sign");
          throw new Error("wallet rejected request");
        },
      }),
    ),
    /wallet rejected request/,
  );
  assert.deepEqual(calls, ["job", "quote", "build", "live-input", "sign"]);
});

test("wrong owners are rejected before any transaction can be built", () => {
  assert.throws(() => assertOwner(job, HASH_A), /not the owner/);
  assert.throws(() => assertOwner(job, undefined), /Connect the owner wallet/);
  assert.doesNotThrow(() => assertOwner(job, HASH_B));
});

test("recovery submission has no executor dependency", async () => {
  const calls: string[] = [];
  const recoveryDependencies = dependencies(calls);
  assert.equal("executor" in recoveryDependencies, false);
  await submitOwnerAction(await review(), recoveryDependencies);
  assert.equal(calls.at(-1), "broadcast");
});

test("submitted action progress survives reload and rejects malformed storage", () => {
  let stored = "";
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value;
    },
  };
  const record = {
    action: "recover",
    persistedAt: "2026-09-24T12:00:00.000Z",
    transactionHash: HASH_A,
    version: 1,
  } as const;
  assert.equal(writeOwnerActionRecord(storage, HASH_B, record), true);
  assert.deepEqual(readOwnerActionRecord(storage, HASH_B), record);
  stored = JSON.stringify({ ...record, transactionHash: "not-a-hash" });
  assert.equal(readOwnerActionRecord(storage, HASH_B), undefined);
});
