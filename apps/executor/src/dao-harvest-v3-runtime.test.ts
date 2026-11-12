import assert from "node:assert/strict";
import test from "node:test";

import { deriveDaoHarvestV3PrepareCreditHash } from "@ckb-automata/core";
import { DaoHarvestPrepareCreditV3, DaoHarvestProgressV3 } from "@ckb-automata/molecule";

import { rebuildDaoHarvestV3Progress } from "./dao-harvest-v3-runtime.ts";

const deposited = DaoHarvestProgressV3.pack({
  version: 3,
  state: 0,
  cycle_index: 4,
  prepare_credit_hash: Array(32).fill(0),
});
const credit = DaoHarvestPrepareCreditV3.pack({
  version: 3,
  job_id: Array(32).fill(2),
  cycle_index: 4,
  preparer_lock_hash: Array(32).fill(1),
  prepared_vault_output_index: 1,
  job_output_index: 0,
});

test("V3 runtime reconstructs canonical successor progress after prepare and claim", () => {
  const withdrawing = DaoHarvestProgressV3.unpack(
    rebuildDaoHarvestV3Progress(1, deposited, credit),
  );
  assert.equal(Number(withdrawing.version), 3);
  assert.equal(Number(withdrawing.state), 1);
  assert.equal(Number(withdrawing.cycle_index), 4);
  assert.deepEqual(
    Uint8Array.from(withdrawing.prepare_credit_hash),
    deriveDaoHarvestV3PrepareCreditHash(credit),
  );

  const nextDeposit = DaoHarvestProgressV3.unpack(
    rebuildDaoHarvestV3Progress(3, DaoHarvestProgressV3.pack(withdrawing), credit),
  );
  assert.equal(Number(nextDeposit.version), 3);
  assert.equal(Number(nextDeposit.state), 0);
  assert.equal(Number(nextDeposit.cycle_index), 5);
  assert.deepEqual(Uint8Array.from(nextDeposit.prepare_credit_hash), new Uint8Array(32));
});

test("V3 runtime preserves progress for owner and maintenance operations", () => {
  assert.equal(rebuildDaoHarvestV3Progress(8, deposited, new Uint8Array()), deposited);
  assert.equal(rebuildDaoHarvestV3Progress(9, deposited, new Uint8Array()), deposited);
});
