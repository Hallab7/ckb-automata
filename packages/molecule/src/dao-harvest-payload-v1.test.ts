import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bytes } from "@ckb-lumos/codec";

import { DaoHarvestPayloadV1 } from "./generated/dao_harvest_v1.ts";

interface DaoHarvestFixture {
  version: number;
  owner_lock_hash: string;
  payout_lock_hash: string;
  vault_lock_hash: string;
  principal_capacity: string;
  prepare_executor_set_hash: string;
  executor_reward: string;
  min_compensation: string;
  prepare_buffer_epochs: string;
  confirmation_margin_epochs: string;
  total_cycles: number;
  end_epoch_since: string;
  expected_hex: string;
}

function byteArray(hex: string): number[] {
  return Array.from(bytes.bytify(hex));
}

test("DaoHarvestPayloadV1 matches the cross-language fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/dao_harvest_payload_v1.json", import.meta.url),
      "utf8",
    ),
  ) as DaoHarvestFixture;
  const encoded = DaoHarvestPayloadV1.pack({
    version: fixture.version,
    owner_lock_hash: byteArray(fixture.owner_lock_hash),
    payout_lock_hash: byteArray(fixture.payout_lock_hash),
    vault_lock_hash: byteArray(fixture.vault_lock_hash),
    principal_capacity: fixture.principal_capacity,
    prepare_executor_set_hash: byteArray(fixture.prepare_executor_set_hash),
    executor_reward: fixture.executor_reward,
    min_compensation: fixture.min_compensation,
    prepare_buffer_epochs: fixture.prepare_buffer_epochs,
    confirmation_margin_epochs: fixture.confirmation_margin_epochs,
    total_cycles: fixture.total_cycles,
    end_epoch_since: fixture.end_epoch_since,
  });

  assert.equal(bytes.hexify(encoded), fixture.expected_hex);
  const decoded = DaoHarvestPayloadV1.unpack(encoded);
  assert.equal(decoded.principal_capacity.toString(), fixture.principal_capacity);
  assert.equal(decoded.total_cycles, fixture.total_cycles);
});
