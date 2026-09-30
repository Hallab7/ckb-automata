import assert from "node:assert/strict";
import test from "node:test";

import type { ApiDaoHarvest } from "@ckb-automata/api-client";

import { daoHarvestPresentation, formatHarvestPrincipal } from "./presentation.ts";

function job(state: ApiDaoHarvest["state"]): ApiDaoHarvest {
  return {
    jobId: `0x${"1".repeat(64)}`,
    ownerLockHash: `0x${"2".repeat(64)}`,
    payoutLockHash: `0x${"3".repeat(64)}`,
    principal: "100000000000",
    progress: { completedCycles: "1", totalCycles: "3" },
    schedule: {
      claimMaturitySince: null,
      depositEpochSince: "1",
      prepareCutoffSince: "2",
      prepareStartSince: "1",
    },
    state,
    economics: {},
    source: {},
    updatedAt: "2026-09-30T00:00:00.000Z",
    vaultOutPoint: {},
  };
}

test("harvest states use the simple waiting, processing, and completed language", () => {
  assert.equal(daoHarvestPresentation(job("deposited")).statusLabel, "Waiting");
  assert.equal(daoHarvestPresentation(job("withdrawing")).statusLabel, "Processing");
  assert.equal(daoHarvestPresentation(job("claim_ready")).statusLabel, "Processing");
  assert.equal(daoHarvestPresentation(job("completed")).statusLabel, "Completed");
  assert.equal(daoHarvestPresentation(job("recovery_required")).statusLabel, "Recovery needed");
});

test("harvest principal formatting is exact and never uses floating point", () => {
  assert.equal(formatHarvestPrincipal("100000000001"), "1,000.00000001 CKB");
  assert.equal(formatHarvestPrincipal("bad"), "Amount unavailable");
});
