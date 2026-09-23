import assert from "node:assert/strict";
import test from "node:test";

import {
  CKB_TESTNET_EXPLORER_ORIGIN,
  ckbTestnetAddressUrl,
  formatCkbBalance,
  shortenCkbAddress,
} from "./wallet-display.ts";

test("wallet values remain exact and scannable", () => {
  assert.equal(shortenCkbAddress("ckt1short"), "ckt1short");
  assert.equal(
    shortenCkbAddress("ckt1qyqv4exampleaddressforautomata9p7m2"),
    "ckt1qyqv4e...ata9p7m2",
  );
  assert.equal(formatCkbBalance(0n), "0 CKB");
  assert.equal(formatCkbBalance(100_000_000n), "1 CKB");
  assert.equal(formatCkbBalance(123_456_789n), "1.23456789 CKB");
  assert.equal(formatCkbBalance(123_456_789_000_000n), "1,234,567.89 CKB");
  assert.throws(() => formatCkbBalance(-1n), /cannot be negative/);
});

test("wallet explorer links cannot leave the public testnet explorer", () => {
  assert.equal(CKB_TESTNET_EXPLORER_ORIGIN, "https://testnet.explorer.nervos.org");
  const url = new URL(ckbTestnetAddressUrl("ckt1/address?network=mainnet"));
  assert.equal(url.origin, CKB_TESTNET_EXPLORER_ORIGIN);
  assert.equal(url.pathname, "/address/ckt1%2Faddress%3Fnetwork%3Dmainnet");
  assert.equal(url.search, "");
});
