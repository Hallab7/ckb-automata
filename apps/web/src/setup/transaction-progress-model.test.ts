import assert from "node:assert/strict";
import test from "node:test";

import type { ApiTransactionProgress } from "@ckb-automata/api-client";

import {
  initialTransactionProgress,
  parseTransactionProgress,
  progressQuery,
  readTransactionProgress,
  sameTransactionProgress,
  transactionConfirmationLabel,
  transactionProgressPresentation,
  transactionProgressStorageKey,
  writeTransactionProgress,
} from "./transaction-progress-model.ts";

const HASH = `0x${"12".repeat(32)}`;
const BLOCK_HASH = `0x${"34".repeat(32)}`;
const SUBMITTED_AT = "2026-09-24T10:00:00.000Z";
const committed = Object.freeze({
  transactionHash: HASH,
  state: "committed",
  confirmations: "2",
  requiredConfirmations: 3,
  block: Object.freeze({ number: "100", hash: BLOCK_HASH }),
  observedAt: "2026-09-24T10:01:00.000Z",
  reason: null,
}) satisfies ApiTransactionProgress;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

test("progress survives reload with its canonical inclusion context", () => {
  const storage = memoryStorage();
  assert.equal(writeTransactionProgress(storage, committed), true);
  assert.deepEqual(readTransactionProgress(storage, HASH), committed);
  assert.deepEqual(progressQuery(SUBMITTED_AT, readTransactionProgress(storage, HASH)), {
    submittedAt: SUBMITTED_AT,
    previousBlockNumber: "100",
    previousBlockHash: BLOCK_HASH,
  });
  assert.ok(storage.values.has(transactionProgressStorageKey(HASH)));
});

test("invalid or cross-transaction progress is ignored", () => {
  const storage = memoryStorage();
  storage.setItem(transactionProgressStorageKey(HASH), "not json");
  assert.equal(readTransactionProgress(storage, HASH), undefined);
  assert.equal(parseTransactionProgress({ ...committed, confirmations: "01" }), undefined);
  assert.equal(parseTransactionProgress({ ...committed, state: "complete" }), undefined);
  assert.equal(
    readTransactionProgress(
      { getItem: () => JSON.stringify({ ...committed, transactionHash: `0x${"ff".repeat(32)}` }) },
      HASH,
    ),
    undefined,
  );
});

test("new submissions start neutral and snapshots compare without observed-at churn", () => {
  const initial = initialTransactionProgress(HASH, SUBMITTED_AT);
  assert.equal(initial.state, "submitted");
  assert.deepEqual(progressQuery(SUBMITTED_AT, initial), { submittedAt: SUBMITTED_AT });
  assert.equal(
    sameTransactionProgress(committed, {
      ...committed,
      observedAt: "2026-09-24T10:02:00.000Z",
    }),
    true,
  );
});

test("storage failures leave progress tracking operational", () => {
  assert.equal(
    writeTransactionProgress(
      {
        setItem: () => {
          throw new Error("quota");
        },
      },
      committed,
    ),
    false,
  );
  assert.equal(
    readTransactionProgress(
      {
        getItem: () => {
          throw new Error("denied");
        },
      },
      HASH,
    ),
    undefined,
  );
});

test("only canonical confirmation uses success copy and styling", () => {
  assert.deepEqual(transactionProgressPresentation("confirmed"), {
    title: "Confirmed",
    detail: "The required canonical confirmation depth has been reached.",
    tone: "success",
  });
  for (const state of [
    "submitted",
    "proposed",
    "committed",
    "dropped",
    "conflicted",
    "reorged",
  ] as const) {
    assert.notEqual(transactionProgressPresentation(state).tone, "success", state);
  }
  assert.equal(transactionProgressPresentation("committed").title, "Committed");
});

test("confirmation label stops at the required depth", () => {
  assert.equal(transactionConfirmationLabel(committed), "2 / 3");
  assert.equal(
    transactionConfirmationLabel({ confirmations: "36", requiredConfirmations: 24 }),
    "24 / 24",
  );
});
