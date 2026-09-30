import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DAO_HARVEST_DAO_STATES,
  classifyDaoHarvestCellData,
  deriveDaoHarvestPayloadHash,
  derivePrepareExecutorSetHash,
  normalizePrepareExecutorSet,
} from "./dao-harvest.ts";

interface DaoHarvestFixture {
  policy_script_hash: string;
  prepare_executor_lock_hashes: string[];
  prepare_executor_set_hash: string;
  expected_hex: string;
  expected_payload_hash: string;
}

function decodeHex(value: string): Uint8Array {
  const digits = value.startsWith("0x") ? value.slice(2) : value;
  if (digits.length % 2 !== 0) throw new RangeError("hex must contain whole bytes");
  return Uint8Array.from({ length: digits.length / 2 }, (_, index) =>
    Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16),
  );
}

function encodeHex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function fixture(): Promise<DaoHarvestFixture> {
  return JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/dao_harvest_payload_v1.json", import.meta.url),
      "utf8",
    ),
  ) as DaoHarvestFixture;
}

test("DAO harvest hashes match the Rust fixture", async () => {
  const value = await fixture();
  const executors = value.prepare_executor_lock_hashes.map(decodeHex);
  assert.equal(encodeHex(derivePrepareExecutorSetHash(executors)), value.prepare_executor_set_hash);
  assert.equal(
    encodeHex(
      deriveDaoHarvestPayloadHash(
        decodeHex(value.policy_script_hash),
        decodeHex(value.expected_hex),
      ),
    ),
    value.expected_payload_hash,
  );
});

test("executor sets are sorted, bounded, unique, and copied", () => {
  const first = Uint8Array.from({ length: 32 }, () => 0x11);
  const second = Uint8Array.from({ length: 32 }, () => 0x22);
  const normalized = normalizePrepareExecutorSet([second, first]);
  assert.deepEqual(normalized, [first, second]);
  assert.throws(() => normalizePrepareExecutorSet([]), /1 to 8/);
  assert.throws(
    () => normalizePrepareExecutorSet(Array.from({ length: 9 }, () => first)),
    /1 to 8/,
  );
  assert.throws(() => normalizePrepareExecutorSet([first, first]), /duplicate/);
  assert.throws(() => normalizePrepareExecutorSet([new Uint8Array(31)]), /32 bytes/);
});

test("DAO cell state is derived from its canonical eight-byte data", () => {
  assert.equal(classifyDaoHarvestCellData(new Uint8Array(8)), DAO_HARVEST_DAO_STATES.DEPOSITED);
  const withdrawing = new Uint8Array(8);
  withdrawing[0] = 1;
  assert.equal(classifyDaoHarvestCellData(withdrawing), DAO_HARVEST_DAO_STATES.WITHDRAWING);
  assert.throws(() => classifyDaoHarvestCellData(new Uint8Array(7)), /exactly 8 bytes/);
});
