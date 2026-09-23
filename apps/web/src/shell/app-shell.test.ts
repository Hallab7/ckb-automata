import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shellSource = await readFile(new URL("./app-shell.tsx", import.meta.url), "utf8");
const shellStyles = await readFile(new URL("./app-shell.css", import.meta.url), "utf8");
const walletSource = await readFile(new URL("../ccc/wallet-control.tsx", import.meta.url), "utf8");

test("application shell exposes keyboard and landmark navigation", () => {
  assert.match(shellSource, /href="#main-content"/);
  assert.match(shellSource, /<main className="app-main" id="main-content" tabIndex=\{-1\}>/);
  assert.match(shellSource, /aria-current=\{isActive\(pathname, item\) \? "page" : undefined\}/);
  assert.match(shellSource, /aria-label="Primary"/);
  assert.match(shellSource, /label="Open navigation"/);
  assert.match(shellSource, /pathname\.startsWith\("\/automations\/new"\)/);
});

test("network, wallet, and notification state remain explicit in text", () => {
  assert.match(shellSource, /app-network-badge__prefix/);
  assert.match(shellSource, /Testnet/);
  assert.match(walletSource, /Connect wallet/);
  assert.match(walletSource, /Wrong wallet network/);
  assert.match(walletSource, /Disconnect wallet/);
  assert.match(walletSource, /CKB Pudge Testnet/);
  assert.match(walletSource, /formatCkbBalance/);
  assert.match(walletSource, /ckbTestnetAddressUrl/);
  assert.match(shellSource, /<NotificationCenter \/>/);
});

test("responsive shell reserves content space and protects narrow actions", () => {
  assert.match(shellStyles, /grid-template-columns: 16\.5rem minmax\(0, 1fr\)/);
  assert.match(shellStyles, /@media \(max-width: 52rem\)/);
  assert.match(shellStyles, /@media \(max-width: 30rem\)/);
  assert.match(shellStyles, /\.app-page-header__actions[\s\S]*width: 100%/);
  assert.match(shellStyles, /max-width: var\(--ui-content-max\)/);
});
