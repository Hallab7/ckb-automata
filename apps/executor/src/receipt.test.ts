import assert from "node:assert/strict";
import test from "node:test";

import { parseHash32 } from "@ckb-automata/core";

import type { ConfirmationAttempt, ConfirmationTransition } from "./confirmation.ts";
import {
  EXECUTOR_RECEIPT_AUTHORITY,
  ExecutorReceiptSigner,
  verifyExecutorReceipt,
} from "./receipt.ts";
import { operatorLockArgs } from "./signing.ts";

const PRIVATE_KEY = `0x${"09".repeat(32)}`;
const ATTEMPT = Object.freeze({
  attemptId: "00000000-0000-4000-8000-000000000079",
  jobId: parseHash32(`0x${"79".repeat(32)}`),
  sequence: "7",
  transactionHash: parseHash32(`0x${"7a".repeat(32)}`),
  state: "committed",
  submittedAt: new Date("2026-09-23T14:00:00.000Z"),
  committedBlockNumber: "100",
} satisfies ConfirmationAttempt);
const TRANSITION = Object.freeze({
  state: "confirmed",
  eventType: "transaction_confirmed",
  observedStatus: "committed",
  block: Object.freeze({
    blockNumber: "100",
    blockHash: parseHash32(`0x${"64".repeat(32)}`),
    source: "indexed_event",
  }),
  confirmations: "2",
  requiredDepth: 2,
} satisfies ConfirmationTransition);

function signer() {
  return new ExecutorReceiptSigner({
    network: "ckb_dev",
    privateKey: PRIVATE_KEY,
    executorLock: {
      codeHash: parseHash32(`0x${"01".repeat(32)}`),
      hashType: "type",
      args: operatorLockArgs(PRIVATE_KEY),
    },
    version: "0.0.0-test",
    revision: "1234567",
    receiptId: () => "00000000-0000-4000-8000-000000000179",
  });
}

test("signed executor receipts are portable and explicitly non-authoritative", () => {
  const receipt = signer().issue(ATTEMPT, TRANSITION, new Date("2026-09-23T14:02:00.000Z"));
  assert.equal(receipt.payload.authority, EXECUTOR_RECEIPT_AUTHORITY);
  assert.equal(receipt.payload.outcome.state, "confirmed");
  assert.equal(receipt.payload.chain.block?.number, "100");
  assert.equal(receipt.payload.software.revision, "1234567");
  assert.equal(verifyExecutorReceipt(receipt), true);

  const tamperedPayload = {
    ...receipt,
    payload: {
      ...receipt.payload,
      outcome: { state: "dropped" as const, errorCode: "EXECUTOR_TX_DROPPED" },
    },
  };
  assert.equal(verifyExecutorReceipt(tamperedPayload), false);

  const last = receipt.signature.at(-1);
  assert.ok(last);
  const tamperedSignature = {
    ...receipt,
    signature: `${receipt.signature.slice(0, -1)}${last === "0" ? "1" : "0"}` as `0x${string}`,
  };
  assert.equal(verifyExecutorReceipt(tamperedSignature), false);
});

test("receipt verification binds the signing key to the full executor lock", () => {
  const receipt = signer().issue(ATTEMPT, TRANSITION, new Date("2026-09-23T14:02:00.000Z"));
  const wrongIdentity = {
    ...receipt,
    payload: {
      ...receipt.payload,
      executor: {
        ...receipt.payload.executor,
        lock: {
          ...receipt.payload.executor.lock,
          codeHash: parseHash32(`0x${"02".repeat(32)}`),
        },
      },
    },
  };
  assert.equal(verifyExecutorReceipt(wrongIdentity), false);
  assert.throws(
    () => signer().issue(ATTEMPT, { ...TRANSITION, state: "reorged" }, new Date()),
    /terminal executor outcomes/,
  );
  assert.throws(
    () => signer().issue(ATTEMPT, TRANSITION, new Date("2026-09-23T13:59:59.000Z")),
    /cannot precede transaction submission/,
  );
});
