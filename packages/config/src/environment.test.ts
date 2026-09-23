import assert from "node:assert/strict";
import test from "node:test";

import { ENVIRONMENT_PROFILES, parseEnvironment, type EnvironmentProfile } from "./environment.ts";

const GENESIS_HASH = `0x${"1".repeat(64)}`;

function validEnvironment(profile: EnvironmentProfile) {
  const isTestnet = profile.startsWith("testnet-");
  return {
    AUTOMATA_PROFILE: profile,
    CKB_NETWORK: isTestnet ? "ckb_testnet" : "ckb_dev",
    CKB_GENESIS_HASH: GENESIS_HASH,
    CKB_RPC_URL: isTestnet ? "https://testnet-rpc.example.invalid" : "http://127.0.0.1:8114",
    CKB_INDEXER_URL: isTestnet
      ? "https://testnet-indexer.example.invalid"
      : "http://127.0.0.1:8116",
    DATABASE_URL: "postgresql://automata:local@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: isTestnet ? "https://automata.example.invalid" : "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

for (const profile of ENVIRONMENT_PROFILES) {
  test(`${profile} accepts its required network identity`, () => {
    const result = parseEnvironment(validEnvironment(profile));
    assert.equal(result.AUTOMATA_PROFILE, profile);
  });

  test(`${profile} rejects the other network identity`, () => {
    const input = validEnvironment(profile);
    input.CKB_NETWORK = input.CKB_NETWORK === "ckb_dev" ? "ckb_testnet" : "ckb_dev";
    assert.throws(() => parseEnvironment(input));
  });
}

test("a missing profile fails startup validation", () => {
  const input: Record<string, string | undefined> = validEnvironment("local");
  delete input["AUTOMATA_PROFILE"];
  assert.throws(() => parseEnvironment(input));
});

test("an unknown profile fails startup validation", () => {
  assert.throws(() =>
    parseEnvironment({
      ...validEnvironment("local"),
      AUTOMATA_PROFILE: "development",
    }),
  );
});

test("a mainnet identifier is never accepted", () => {
  assert.throws(() =>
    parseEnvironment({
      ...validEnvironment("testnet-public"),
      CKB_NETWORK: "ckb_mainnet",
    }),
  );
});

test("unrelated process values do not enter the parsed configuration", () => {
  const result = parseEnvironment({
    ...validEnvironment("test"),
    PATH: "ignored",
  });
  assert.equal("PATH" in result, false);
});

test("user signing material fails startup validation", () => {
  assert.throws(
    () =>
      parseEnvironment({
        ...validEnvironment("local"),
        USER_SEED_PHRASE: "never accepted",
      }),
    /USER_SEED_PHRASE is forbidden/,
  );
});
