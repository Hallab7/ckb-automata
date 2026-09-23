import assert from "node:assert/strict";
import test from "node:test";

import { CANONICAL_TRANSACTION_STATES } from "@ckb-automata/core";

import { TRANSACTION_STATE_LABELS } from "./labels.ts";

test("UI copy covers every canonical transaction state", () => {
  assert.deepEqual(Object.keys(TRANSACTION_STATE_LABELS), [...CANONICAL_TRANSACTION_STATES]);
  assert.equal(TRANSACTION_STATE_LABELS.committed, "Committed");
  assert.equal(TRANSACTION_STATE_LABELS.confirmed, "Confirmed");
});
