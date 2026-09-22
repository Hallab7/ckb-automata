import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { AuthService } from "../apps/api/src/auth.ts";
import { createDatabaseClient } from "../apps/api/src/database/client.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const cccModule = await import(pathToFileURL(requireFromApi.resolve("@ckb-ccc/shell")).href);
const { Script, SignerCkbPrivateKey, hashCkbShort } = cccModule.default ?? cccModule;
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for auth verification");

const databaseName = `automata_auth_${randomBytes(6).toString("hex")}`;
if (!/^automata_auth_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error("Refusing to manage an unexpected database name");
}
const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const testUrl = new URL(adminConnectionString);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
let databaseClient;
let inspect;

const genesisHash = `0x${"05".repeat(32)}`;
const codeHash = `0x${"06".repeat(32)}`;
const privateKey = `0x${"07".repeat(32)}`;
const otherPrivateKey = `0x${"08".repeat(32)}`;
const signer = new SignerCkbPrivateKey({}, privateKey);
const otherSigner = new SignerCkbPrivateKey({}, otherPrivateKey);
const ownerLock = Script.from({
  args: hashCkbShort(signer.publicKey),
  codeHash,
  hashType: "type",
});
const ownerLockJson = {
  args: ownerLock.args,
  codeHash: ownerLock.codeHash,
  hashType: ownerLock.hashType,
};
const environment = {
  CKB_NETWORK: "ckb_dev",
  PUBLIC_APP_ORIGIN: "https://automata.example.test/app",
};

async function rejectedCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.getStatus?.(), code === "INVALID_AUTH_REQUEST" ? 400 : 401);
    assert.equal(error?.getResponse?.().code, code);
    return true;
  });
}

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await migrateDatabase({ connectionString: testUrl.href });
  inspect = postgres(testUrl.href, { max: 1, onnotice: () => undefined });
  await inspect`
    INSERT INTO networks (
      id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
    ) VALUES ('ckb_dev', ${genesisHash}, 'local', 2, ${"a".repeat(64)})
  `;
  databaseClient = createDatabaseClient(testUrl.href);
  const auth = new AuthService(databaseClient.database, environment);
  const challenge = await auth.issue({ ownerLockHash: ownerLock.hash() });
  assert.equal(challenge.domain, "https://automata.example.test");
  assert.equal(challenge.network, "ckb_dev");
  const signature = await signer.signMessage(challenge.message);
  const proof = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    ownerLock: ownerLockJson,
    signature,
  };

  const wrongOwnerSignature = await otherSigner.signMessage(challenge.message);
  await rejectedCode(
    () => auth.verify({ ...proof, signature: wrongOwnerSignature }),
    "AUTH_SIGNATURE_INVALID",
  );
  const wrongDomain = new AuthService(databaseClient.database, {
    ...environment,
    PUBLIC_APP_ORIGIN: "https://wrong.example.test",
  });
  await rejectedCode(() => wrongDomain.verify(proof), "AUTH_SIGNATURE_INVALID");
  const wrongNetwork = new AuthService(databaseClient.database, {
    ...environment,
    CKB_NETWORK: "ckb_testnet",
  });
  await rejectedCode(() => wrongNetwork.verify(proof), "AUTH_CHALLENGE_INVALID");
  await rejectedCode(
    () => auth.verify({ ...proof, signature: { ...signature, signature: `0x${"00".repeat(65)}` } }),
    "AUTH_SIGNATURE_INVALID",
  );
  await rejectedCode(
    () => auth.verify({ ...proof, signature: { ...signature, signature: "not-a-signature" } }),
    "INVALID_AUTH_REQUEST",
  );

  let clock = new Date("2026-09-22T12:00:00.000Z");
  const expiringAuth = new AuthService(databaseClient.database, environment, { now: () => clock });
  const expiringChallenge = await expiringAuth.issue({ ownerLockHash: ownerLock.hash() });
  const expiringSignature = await signer.signMessage(expiringChallenge.message);
  clock = new Date("2026-09-22T12:05:00.000Z");
  await rejectedCode(
    () =>
      expiringAuth.verify({
        challengeId: expiringChallenge.challengeId,
        nonce: expiringChallenge.nonce,
        ownerLock: ownerLockJson,
        signature: expiringSignature,
      }),
    "AUTH_CHALLENGE_EXPIRED",
  );

  const session = await auth.verify(proof);
  assert.deepEqual(session.scope, ["off_chain_settings"]);
  const authenticated = await auth.authenticate(`Bearer ${session.sessionToken}`);
  assert.equal(authenticated.ownerLockHash, ownerLock.hash());
  assert.equal(authenticated.scope, "off_chain_settings");
  await rejectedCode(() => auth.verify(proof), "AUTH_CHALLENGE_USED");
  await rejectedCode(() => auth.authenticate(`Bearer ${"A".repeat(43)}`), "AUTH_SESSION_INVALID");

  const racingChallenge = await auth.issue({ ownerLockHash: ownerLock.hash() });
  const racingSignature = await signer.signMessage(racingChallenge.message);
  const racingProof = {
    challengeId: racingChallenge.challengeId,
    nonce: racingChallenge.nonce,
    ownerLock: ownerLockJson,
    signature: racingSignature,
  };
  const racingResults = await Promise.allSettled([
    auth.verify(racingProof),
    auth.verify(racingProof),
  ]);
  assert.equal(racingResults.filter(({ status }) => status === "fulfilled").length, 1);
  const racingRejection = racingResults.find(({ status }) => status === "rejected");
  assert.equal(racingRejection?.reason?.getResponse?.().code, "AUTH_CHALLENGE_USED");

  const [storedChallenge] = await inspect`
    SELECT nonce_hash, consumed_at FROM auth_challenges WHERE id = ${challenge.challengeId}
  `;
  const [storedSession] = await inspect`
    SELECT token_hash, scope FROM auth_sessions WHERE id = ${authenticated.id}
  `;
  assert.notEqual(storedChallenge.nonce_hash, challenge.nonce);
  assert.ok(storedChallenge.consumed_at);
  assert.notEqual(storedSession.token_hash, session.sessionToken);
  assert.equal(storedSession.scope, "off_chain_settings");

  console.log(
    "Auth verified: CCC signature, owner binding, separation, expiry, replay, and hashed session",
  );
} finally {
  await databaseClient?.close();
  await inspect?.end({ timeout: 2 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
