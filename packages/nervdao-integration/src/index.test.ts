import assert from "node:assert/strict";
import test from "node:test";

import {
  NERVDAO_HARVEST_TESTNET_NOTICE,
  NERVDAO_HARVEST_TIMING_NOTICES,
  assertNervDaoReviewUnchanged,
  assertNervDaoTestnetIdentity,
  nervDaoOwnerAction,
  nervDaoPositionLabel,
  type NervDaoReviewIdentity,
} from "./index.ts";

const hash = (value: string) => `0x${value.repeat(64)}`;
const review = (): NervDaoReviewIdentity => ({
  version: 3,
  jobId: hash("1"),
  operation: "owner-exit",
  intentHash: hash("2"),
  chain: { genesisHash: hash("a"), manifestSha256: "b".repeat(64) },
});

test("testnet identity binds signer genesis and the exact V3 manifest", () => {
  const value = review();
  assert.doesNotThrow(() => assertNervDaoTestnetIdentity(value.chain, hash("a"), value.chain));
  assert.throws(
    () => assertNervDaoTestnetIdentity(value.chain, hash("9"), value.chain),
    /approved testnet/,
  );
  assert.throws(
    () =>
      assertNervDaoTestnetIdentity(value.chain, hash("a"), {
        ...value.chain,
        manifestSha256: "c".repeat(64),
      }),
    /approved testnet/,
  );
});

test("review refresh binds action, intent, network, and deployment", () => {
  const value = review();
  assert.doesNotThrow(() => assertNervDaoReviewUnchanged(value, structuredClone(value)));
  assert.throws(
    () =>
      assertNervDaoReviewUnchanged(value, {
        ...value,
        chain: { ...value.chain, manifestSha256: "c".repeat(64) },
      }),
    /review changed/,
  );
});

test("status and owner actions derive only from canonical position state", () => {
  assert.equal(nervDaoOwnerAction("deposited", false), "owner-exit");
  assert.equal(nervDaoOwnerAction("withdrawing", true), "owner-recovery");
  assert.equal(nervDaoOwnerAction("withdrawing", false), undefined);
  assert.equal(nervDaoPositionLabel("deposited"), "Waiting");
  assert.equal(nervDaoPositionLabel("withdrawing"), "Processing");
  assert.equal(nervDaoPositionLabel("closed"), "Completed");
});

test("plain-language notices disclose timing authority and testnet audit limits", () => {
  assert.match(NERVDAO_HARVEST_TESTNET_NOTICE.body, /testnet funds only/i);
  assert.match(NERVDAO_HARVEST_TESTNET_NOTICE.body, /professional audit/i);
  assert.ok(NERVDAO_HARVEST_TIMING_NOTICES.some((notice) => /180 DAO epochs/.test(notice)));
  assert.ok(NERVDAO_HARVEST_TIMING_NOTICES.some((notice) => /cannot cancel/.test(notice)));
  assert.ok(
    NERVDAO_HARVEST_TIMING_NOTICES.some((notice) => /do not become spendable/.test(notice)),
  );
});
