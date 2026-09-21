import assert from "node:assert/strict";
import test from "node:test";

import { CANONICAL_TRANSACTION_STATES } from "@ckb-automata/core";

import { API_TRANSACTION_STATE_VALUES } from "./index.ts";

test("API transaction values are the canonical values", () => {
  assert.equal(API_TRANSACTION_STATE_VALUES, CANONICAL_TRANSACTION_STATES);
});
