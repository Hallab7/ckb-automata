import assert from "node:assert/strict";
import test from "node:test";

import { clientDaoAccumulatedRate, clientDaoHex } from "./dao.ts";

const raw = "0x0100000000000000020000000000000003000000000000000400000000000000" as const;

test("normalizes the structured DAO value returned by the live CCC client", () => {
  const value = { c: 1n, ar: 2n, s: 3n, u: 4n };
  assert.equal(clientDaoHex(value), raw);
  assert.equal(clientDaoAccumulatedRate(value), 2n);
});

test("reads accumulated rate from the second uint64 of a raw DAO header", () => {
  assert.equal(clientDaoHex(raw), raw);
  assert.equal(clientDaoAccumulatedRate(raw), 2n);
});

test("rejects incomplete DAO fields", () => {
  assert.throws(() => clientDaoHex({ c: 1n, ar: 2n, s: 3n }), /fields are incomplete/);
});
