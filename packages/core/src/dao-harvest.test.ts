import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DAO_HARVEST_DAO_STATES,
  classifyDaoHarvestCellData,
  deriveDaoHarvestPayloadHash,
  deriveDaoHarvestVaultCommitment,
  derivePrepareExecutorSetHash,
  normalizePrepareExecutorSet,
} from "./dao-harvest.ts";

interface DaoHarvestFixture {
  policy_script_hash: string;
  prepare_executor_lock_hashes: string[];
  prepare_executor_set_hash: string;
  expected_hex: string;
  expected_payload_hash: string;
  expected_vault_commitment: string;
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

function littleEndian(input: string | number, bytes: 2 | 4 | 8): Uint8Array {
  const encoded = new Uint8Array(bytes);
  const view = new DataView(encoded.buffer);
  if (bytes === 2) view.setUint16(0, Number(input), true);
  else if (bytes === 4) view.setUint32(0, Number(input), true);
  else view.setBigUint64(0, BigInt(input), true);
  return encoded;
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
  const raw = JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/dao_harvest_payload_v1.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, string | number>;
  assert.equal(
    encodeHex(
      deriveDaoHarvestVaultCommitment({
        version: littleEndian(raw["version"]!, 2),
        ownerLockHash: decodeHex(String(raw["owner_lock_hash"])),
        payoutLockHash: decodeHex(String(raw["payout_lock_hash"])),
        daoTypeHash: decodeHex(String(raw["dao_type_hash"])),
        principalCapacity: littleEndian(raw["principal_capacity"]!, 8),
        executorReward: littleEndian(raw["executor_reward"]!, 8),
        minCompensation: littleEndian(raw["min_compensation"]!, 8),
        prepareBufferEpochs: littleEndian(raw["prepare_buffer_epochs"]!, 8),
        confirmationMarginEpochs: littleEndian(raw["confirmation_margin_epochs"]!, 8),
        totalCycles: littleEndian(raw["total_cycles"]!, 4),
        endEpochSince: littleEndian(raw["end_epoch_since"]!, 8),
      }),
    ),
    value.expected_vault_commitment,
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
