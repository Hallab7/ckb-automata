import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_CAPACITY,
  minimumCampaignCellCapacity,
  minimumJobCellCapacity,
} from "./contract-costs.ts";
import { parseShannons } from "./chain-values.ts";

test("funding minima include measured occupied capacity", () => {
  assert.equal(CONTRACT_CAPACITY.plainWalletCell, 6_100_000_000n);
  assert.equal(minimumJobCellCapacity(parseShannons(30_000_000_000n)), 68_100_000_000n);
  assert.equal(minimumCampaignCellCapacity(parseShannons(20_000_000_000n)), 47_300_000_000n);
});

test("funding minima reject negative amounts", () => {
  assert.throws(() => minimumJobCellCapacity(parseShannons(-1n)), RangeError);
  assert.throws(() => minimumCampaignCellCapacity(parseShannons(-1n)), RangeError);
});
