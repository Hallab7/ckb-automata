import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_CAPACITY,
  minimumCampaignCellCapacity,
  minimumJobCellCapacity,
  minimumPlainCellCapacity,
} from "./contract-costs.ts";
import { parseHash32, parseShannons } from "./chain-values.ts";

test("funding minima include measured occupied capacity", () => {
  assert.equal(CONTRACT_CAPACITY.plainWalletCell, 6_100_000_000n);
  assert.equal(minimumJobCellCapacity(parseShannons(30_000_000_000n)), 68_100_000_000n);
  assert.equal(minimumCampaignCellCapacity(parseShannons(20_000_000_000n)), 47_300_000_000n);
});

test("funding minima reject negative amounts", () => {
  assert.throws(() => minimumJobCellCapacity(parseShannons(-1n)), RangeError);
  assert.throws(() => minimumCampaignCellCapacity(parseShannons(-1n)), RangeError);
});

test("plain output minimum follows the resolved lock args length", () => {
  const lock = {
    codeHash: parseHash32(`0x${"11".repeat(32)}`),
    hashType: "type" as const,
    args: `0x${"22".repeat(20)}` as const,
  };
  assert.equal(minimumPlainCellCapacity(lock), CONTRACT_CAPACITY.plainWalletCell);
  assert.equal(minimumPlainCellCapacity({ ...lock, args: `0x${"22".repeat(22)}` }), 6_300_000_000n);
  assert.throws(() => minimumPlainCellCapacity({ ...lock, args: "0x0" }), TypeError);
});
