import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { AuthService } from "../apps/api/src/auth.ts";
import { createDatabaseClient } from "../apps/api/src/database/client.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";
import { NotificationPreferencesService } from "../apps/api/src/preferences.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const cccModule = await import(pathToFileURL(requireFromApi.resolve("@ckb-ccc/shell")).href);
const { Script, SignerCkbPrivateKey, hashCkbShort } = cccModule.default ?? cccModule;
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for preference verification");

const databaseName = `automata_preferences_${randomBytes(6).toString("hex")}`;
if (!/^automata_preferences_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error("Refusing to manage an unexpected database name");
}
const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const testUrl = new URL(adminConnectionString);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
let databaseClient;
let inspect;

const environment = {
  CKB_NETWORK: "ckb_dev",
  PUBLIC_APP_ORIGIN: "https://automata.example.test",
  WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
};
const hash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

async function createSession(auth, privateKey, codeHash) {
  const signer = new SignerCkbPrivateKey({}, privateKey);
  const ownerLock = Script.from({
    args: hashCkbShort(signer.publicKey),
    codeHash,
    hashType: "type",
  });
  const challenge = await auth.issue({ ownerLockHash: ownerLock.hash() });
  const signature = await signer.signMessage(challenge.message);
  const session = await auth.verify({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    ownerLock: {
      args: ownerLock.args,
      codeHash: ownerLock.codeHash,
      hashType: ownerLock.hashType,
    },
    signature,
  });
  return { authorization: `Bearer ${session.sessionToken}`, ownerLockHash: ownerLock.hash() };
}

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await migrateDatabase({ connectionString: testUrl.href });
  inspect = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  await inspect`
    INSERT INTO networks (
      id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
    ) VALUES ('ckb_dev', ${hash(1)}, 'local', 2, ${"a".repeat(64)})
  `;
  databaseClient = createDatabaseClient(testUrl.href);
  const auth = new AuthService(databaseClient.database, environment);
  const preferences = new NotificationPreferencesService(
    databaseClient.database,
    auth,
    environment,
  );
  const owner = await createSession(auth, hash(7), hash(17));
  const otherOwner = await createSession(auth, hash(8), hash(18));

  const defaults = await preferences.get(owner.authorization);
  assert.equal(defaults.channels.browser.enabled, false);
  assert.equal(defaults.channels.email.enabled, false);
  assert.deepEqual(defaults.channels.browser.eventTypes, []);
  assert.deepEqual(defaults.channels.email.eventTypes, []);

  const enabled = await preferences.update(owner.authorization, {
    browser: { enabled: true, eventTypes: ["ready", "failed"] },
    email: {
      address: "Owner@Example.com",
      enabled: true,
      eventTypes: ["submitted", "confirmed", "recovery_required"],
    },
  });
  assert.equal(enabled.channels.browser.enabled, true);
  assert.equal(enabled.channels.email.enabled, true);
  assert.equal(enabled.channels.email.address, "o***@example.com");
  assert.deepEqual(enabled.channels.browser.eventTypes, ["ready", "failed"]);

  const initialRows = await inspect`
    SELECT id, channel, destination_ciphertext, enabled, created_at
    FROM notification_preferences
    WHERE network_id = 'ckb_dev' AND owner_lock_hash = ${owner.ownerLockHash}
    ORDER BY channel
  `;
  assert.equal(initialRows.length, 2);
  const initialEmail = initialRows.find(({ channel }) => channel === "email");
  assert.ok(initialEmail.destination_ciphertext.startsWith("v1."));
  assert.equal(initialEmail.destination_ciphertext.includes("owner@example.com"), false);

  const isolated = await preferences.get(otherOwner.authorization);
  assert.equal(isolated.ownerLockHash, otherOwner.ownerLockHash);
  assert.equal(isolated.channels.browser.enabled, false);
  assert.equal(isolated.channels.email.address, null);
  await assert.rejects(
    () => preferences.get(undefined),
    (error) => error?.getStatus?.() === 401,
  );

  const disabled = await preferences.update(owner.authorization, {
    browser: { enabled: false, eventTypes: ["ready", "failed"] },
    email: { enabled: false, eventTypes: ["submitted", "confirmed", "recovery_required"] },
  });
  assert.equal(disabled.channels.browser.enabled, false);
  assert.equal(disabled.channels.email.enabled, false);
  assert.equal(disabled.channels.email.address, "o***@example.com");
  const retainedRows = await inspect`
    SELECT id, channel, destination_ciphertext, enabled, created_at
    FROM notification_preferences
    WHERE network_id = 'ckb_dev' AND owner_lock_hash = ${owner.ownerLockHash}
    ORDER BY channel
  `;
  assert.deepEqual(
    retainedRows.map(({ id }) => id),
    initialRows.map(({ id }) => id),
  );
  assert.equal(
    retainedRows.find(({ channel }) => channel === "email").destination_ciphertext,
    initialEmail.destination_ciphertext,
  );
  assert.ok(retainedRows.every(({ enabled: isEnabled }) => !isEnabled));

  const reenabled = await preferences.update(owner.authorization, {
    browser: { enabled: false, eventTypes: [] },
    email: { enabled: true, eventTypes: ["confirmed"] },
  });
  assert.equal(reenabled.channels.email.enabled, true);
  assert.equal(reenabled.channels.email.address, "o***@example.com");

  await preferences.update(owner.authorization, {
    browser: { enabled: false, eventTypes: [] },
    email: { address: null, enabled: false, eventTypes: [] },
  });
  await assert.rejects(
    () =>
      preferences.update(owner.authorization, {
        browser: { enabled: false, eventTypes: [] },
        email: { enabled: true, eventTypes: ["confirmed"] },
      }),
    (error) => error?.getResponse?.().code === "INVALID_NOTIFICATION_PREFERENCES",
  );

  await preferences.update(otherOwner.authorization, {
    browser: { enabled: false, eventTypes: [] },
    email: { enabled: false, eventTypes: [] },
  });
  await inspect`
    INSERT INTO notification_subscriptions (
      id, network_id, owner_lock_hash, channel, destination_ciphertext, event_types, enabled
    ) VALUES
      ('11111111-1111-4111-8111-111111111111', 'ckb_dev', ${owner.ownerLockHash}, 'webhook', 'v1.owner', '["ready"]'::jsonb, true),
      ('22222222-2222-4222-8222-222222222222', 'ckb_dev', ${otherOwner.ownerLockHash}, 'webhook', 'v1.other', '["ready"]'::jsonb, true)
  `;
  const reset = await preferences.reset(owner.authorization);
  assert.equal(reset.ownerLockHash, owner.ownerLockHash);
  assert.equal(reset.channels.browser.enabled, false);
  assert.equal(reset.channels.email.address, null);
  const [resetCounts] = await inspect`
    SELECT
      (SELECT count(*)::integer FROM notification_preferences WHERE owner_lock_hash = ${owner.ownerLockHash}) AS owner_preferences,
      (SELECT count(*)::integer FROM notification_subscriptions WHERE owner_lock_hash = ${owner.ownerLockHash}) AS owner_webhooks,
      (SELECT count(*)::integer FROM notification_preferences WHERE owner_lock_hash = ${otherOwner.ownerLockHash}) AS other_preferences,
      (SELECT count(*)::integer FROM notification_subscriptions WHERE owner_lock_hash = ${otherOwner.ownerLockHash}) AS other_webhooks
  `;
  assert.deepEqual(resetCounts, {
    owner_preferences: 0,
    owner_webhooks: 0,
    other_preferences: 2,
    other_webhooks: 1,
  });

  console.log(
    "Preferences verified: authorization, explicit opt-in, opt-out, isolation, encryption, retention, and owner-only reset",
  );
} finally {
  await databaseClient?.close();
  await inspect?.end({ timeout: 2 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
