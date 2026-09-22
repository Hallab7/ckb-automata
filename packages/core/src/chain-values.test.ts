import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EPOCH_NUMBER,
  MAX_UINT32,
  MAX_UINT64,
  createEpoch,
  hash32FromBytes,
  hash32ToBytes,
  outPointToRpc,
  packEpoch,
  parseBlockNumber,
  parseEpoch,
  parseHash32,
  parseOutPoint,
  parseOutputIndex,
  parseRunCount,
  parseSequence,
  parseSince,
  parseShannons,
  toRpcHex,
  uint32ToLittleEndian,
  uint64ToLittleEndian,
  type BlockNumber,
} from "./chain-values.ts";

test("uint64 money and counters accept only lossless canonical inputs", () => {
  assert.equal(parseShannons("18446744073709551615"), MAX_UINT64);
  assert.equal(parseBlockNumber("0xffffffffffffffff"), MAX_UINT64);
  assert.equal(parseSequence(0n), 0n);
  assert.equal(toRpcHex(parseShannons(255n)), "0xff");
  assert.deepEqual(uint64ToLittleEndian(parseSequence(MAX_UINT64)), new Uint8Array(8).fill(255));
  assert.equal(parseSince("0x40000000000003e8"), 0x40000000000003e8n);

  const money = parseShannons(1n);
  // @ts-expect-error Money and block heights are intentionally distinct brands.
  const block: BlockNumber = money;
  assert.equal(block, 1n);

  for (const invalid of [
    1,
    1.5,
    -1n,
    MAX_UINT64 + 1n,
    "01",
    "0x00",
    "0X1",
    "0xA",
    " 1",
    "1.0",
    null,
  ]) {
    assert.throws(() => parseShannons(invalid as never));
  }
});

test("uint32 run counts and output indices enforce wire boundaries", () => {
  assert.equal(parseRunCount("4294967295"), MAX_UINT32);
  assert.equal(parseOutputIndex("0xffffffff"), MAX_UINT32);
  assert.deepEqual(uint32ToLittleEndian(parseRunCount(MAX_UINT32)), new Uint8Array(4).fill(255));
  assert.throws(() => parseRunCount(MAX_UINT32 + 1n), RangeError);
  assert.throws(() => parseOutputIndex(0 as never), TypeError);
});

test("epochs round-trip the canonical CKB fraction encoding", () => {
  const epoch = createEpoch({ number: "0x200", index: "0x10", length: "0x3e8" });
  assert.equal(packEpoch(epoch), 0x03e8_0010_0002_00n);
  assert.deepEqual(parseEpoch("0x3e80010000200"), epoch);
  assert.equal(parseEpoch("0xffffff").number, MAX_EPOCH_NUMBER);

  assert.throws(() => createEpoch({ number: 1n, index: 1n, length: 1n }), RangeError);
  assert.throws(() => createEpoch({ number: 1n, index: 1n, length: 0n }), RangeError);
  assert.throws(() => parseEpoch(1n << 56n), RangeError);
});

test("hashes and outpoints are canonical and RPC serializable", () => {
  const hash = parseHash32(`0x${"ab".repeat(32)}`);
  assert.equal(hash32FromBytes(hash32ToBytes(hash)), hash);
  const outPoint = parseOutPoint({ txHash: hash, index: "0x2" });
  assert.deepEqual(outPointToRpc(outPoint), { tx_hash: hash, index: "0x2" });
  assert.ok(Object.isFrozen(outPoint));

  for (const invalid of [
    "ab".repeat(32),
    `0x${"AB".repeat(32)}`,
    `0x${"ab".repeat(31)}`,
    `0x${"ab".repeat(33)}`,
  ]) {
    assert.throws(() => parseHash32(invalid), TypeError);
  }
  assert.throws(() => parseOutPoint({ tx_hash: hash, index: "0x2" }), TypeError);
  assert.throws(() => parseOutPoint({ txHash: hash, index: "0x2", extra: true }), TypeError);
});
