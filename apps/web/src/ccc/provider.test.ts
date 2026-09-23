import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  AUTOMATA_CCC_IDENTITY,
  EXPECTED_CKB_ADDRESS_PREFIX,
  PREFERRED_CCC_NETWORKS,
  SUPPORTED_CCC_SIGNER_TYPES,
  deriveWalletReadiness,
  isSupportedSignerType,
} from "./policy.ts";

test("wallet policy is testnet-only and excludes unreviewed signer families", () => {
  assert.deepEqual(AUTOMATA_CCC_IDENTITY, {
    icon: "/automata-mark.svg",
    name: "CKB Automata",
  });
  assert.equal(EXPECTED_CKB_ADDRESS_PREFIX, "ckt");
  assert.deepEqual(SUPPORTED_CCC_SIGNER_TYPES, ["CKB", "BTC"]);
  assert.deepEqual(PREFERRED_CCC_NETWORKS, [
    { addressPrefix: "ckt", network: "btcTestnet", signerType: "BTC" },
  ]);
  assert.equal(isSupportedSignerType("CKB"), true);
  assert.equal(isSupportedSignerType("BTC"), true);
  assert.equal(isSupportedSignerType("EVM"), false);
});

test("wrong network always wins over connection readiness", () => {
  assert.equal(deriveWalletReadiness("ckt", undefined, false), "disconnected");
  assert.equal(deriveWalletReadiness("ckt", "ckt", true, "CKB"), "ready");
  assert.equal(deriveWalletReadiness("ckt", "ckt", true, "EVM"), "unsupported_wallet");
  assert.equal(deriveWalletReadiness("ckb", "ckb", true, "EVM"), "wrong_network");
  assert.equal(deriveWalletReadiness("ckt", "ckb", true, "CKB"), "wrong_network");
});

test("connector runtime stays inside the dedicated client boundary", async () => {
  const sourceDirectory = new URL("../", import.meta.url);
  const files = (await readdir(sourceDirectory, { recursive: true }))
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => /\.[cm]?[jt]sx?$/.test(entry) && !entry.endsWith(".test.ts"));
  const runtimeImports = [];
  for (const file of files) {
    const source = await readFile(new URL(file, sourceDirectory), "utf8");
    const connectorImports = source
      .split(";")
      .filter((statement) => statement.includes('from "@ckb-ccc/connector-react"'));
    if (connectorImports.some((statement) => !statement.trimStart().startsWith("import type"))) {
      runtimeImports.push(file);
    }
  }
  assert.deepEqual(runtimeImports, ["ccc/ccc-provider.tsx"]);

  const provider = await readFile(new URL("./ccc-provider.tsx", import.meta.url), "utf8");
  assert.match(provider, /^"use client";/);
  assert.match(provider, /new ccc\.ClientPublicTestnet\(\)/);
  assert.match(provider, /usePathname\(\) === "\/fixtures\/wallet-provider"/);
  assert.match(provider, /signersController=\{signersController\}/);
  assert.match(provider, /installConnectorClientGuard\(\)/);
  assert.match(provider, /if \(client === undefined\) return/);
  assert.match(provider, /name: AUTOMATA_CCC_IDENTITY\.name/);
  assert.match(provider, /const signer = ccc\.useSigner\(\)/);
  assert.match(provider, /class FixtureSigner extends ccc\.Signer/);

  const session = await readFile(new URL("./session.tsx", import.meta.url), "utf8");
  assert.match(session, /if \(session\.status === "wrong_network"\)/);
  assert.match(session, /if \(session\.status === "unsupported_wallet"\)/);
  assert.match(session, /return session\.status === "ready" \? session\.signer : undefined/);
});
