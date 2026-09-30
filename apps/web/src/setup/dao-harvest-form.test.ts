import assert from "node:assert/strict";
import test from "node:test";

import {
  DAO_HARVEST_INITIAL_DRAFT,
  daoHarvestFundingPreview,
  validateDaoHarvestStep,
} from "./dao-harvest-form.ts";

const owner = `0x${"1".repeat(64)}`;

test("harvest preview keeps principal separate from capped charges", () => {
  const preview = daoHarvestFundingPreview({
    ...DAO_HARVEST_INITIAL_DRAFT,
    principalCkb: "1000",
    recurrence: "finite",
    cycleCount: "3",
  });
  assert.equal(preview.principalCkb, "1000");
  assert.equal(preview.actionCount, 6n);
  assert.equal(preview.chargesCkb, "748");
  assert.equal(preview.recoverableReserveCkb, "381");
  assert.equal(preview.totalCkb, "1748");
});

test("one-time selection ignores a stale finite count", () => {
  const preview = daoHarvestFundingPreview({
    ...DAO_HARVEST_INITIAL_DRAFT,
    principalCkb: "210",
    recurrence: "once",
    cycleCount: "999",
  });
  assert.equal(preview.cycleCount, 1);
  assert.equal(preview.totalCkb, "714");
});

test("harvest validation rejects invalid address, small amount, count, and balance", async () => {
  const errors = await validateDaoHarvestStep(
    "details",
    {
      ...DAO_HARVEST_INITIAL_DRAFT,
      payoutAddress: "not-an-address",
      principalCkb: "209",
      recurrence: "finite",
      cycleCount: "13",
    },
    {
      balanceShannons: 1n,
      ownerLockHash: owner,
      resolveLockHash: async () => Promise.reject(new Error("invalid")),
      walletAddress: "ckt1owner",
      walletReady: true,
    },
  );
  assert.match(errors["principalCkb"] ?? "", /at least 210 CKB/);
  assert.match(errors["payoutAddress"] ?? "", /valid CKB testnet/);
  assert.match(errors["cycleCount"] ?? "", /between 2 and 12/);
});

test("valid harvest details pass for a connected funded wallet", async () => {
  const errors = await validateDaoHarvestStep(
    "details",
    {
      ...DAO_HARVEST_INITIAL_DRAFT,
      payoutAddress: "ckt1payout",
      principalCkb: "1000",
    },
    {
      balanceShannons: 200_000_000_000n,
      ownerLockHash: owner,
      resolveLockHash: async () => `0x${"2".repeat(64)}`,
      walletAddress: "ckt1owner",
      walletReady: true,
    },
  );
  assert.deepEqual(errors, {});
});
