import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("settings authentication remains address-bound and expires in the open page", async () => {
  const source = await readFile(new URL("./settings.tsx", import.meta.url), "utf8");
  assert.match(source, /parseStoredSettingsSession/);
  assert.match(source, /ownerRef\.current !== settingsSession\.ownerLockHash/);
  assert.match(source, /window\.setTimeout/);
  assert.match(source, /window\.sessionStorage/);
  assert.doesNotMatch(source, /window\.localStorage/);
});

test("settings uses server-side revocation, rotation, and atomic owner reset", async () => {
  const source = await readFile(new URL("./settings.tsx", import.meta.url), "utf8");
  assert.match(source, /revokeAuthSession/);
  assert.match(source, /rotateWebhookSecret/);
  assert.match(source, /resetNotificationPreferences/);
  assert.match(source, /replayWebhookDelivery/);
});

test("wallet authentication signs a message without constructing a transaction", async () => {
  const source = await readFile(new URL("../ccc/ccc-provider.tsx", import.meta.url), "utf8");
  const start = source.indexOf("signSettingsMessage:");
  const end = source.indexOf("signReviewedTransaction:", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const implementation = source.slice(start, end);
  assert.match(implementation, /signMessage\(message\)/);
  assert.match(implementation, /SignerSignType\.CkbSecp256k1/);
  assert.doesNotMatch(implementation, /signOnlyTransaction|sendTransaction/);
});
