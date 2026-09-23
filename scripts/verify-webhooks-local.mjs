import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { AuthService } from "../apps/api/src/auth.ts";
import { createDatabaseClient } from "../apps/api/src/database/client.ts";
import { migrateDatabase } from "../apps/api/src/database/migrator.ts";
import { BackendTelemetry, MetricsController } from "../apps/api/src/telemetry.ts";
import { WebhookService, verifyWebhookSignature } from "../apps/api/src/webhooks.ts";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(requireFromApi.resolve("postgres")).href)).default;
const cccModule = await import(pathToFileURL(requireFromApi.resolve("@ckb-ccc/shell")).href);
const { Script, SignerCkbPrivateKey, hashCkbShort } = cccModule.default ?? cccModule;
const adminConnectionString = process.env["DATABASE_URL"];
if (!adminConnectionString) throw new Error("DATABASE_URL is required for webhook verification");

const databaseName = `automata_webhooks_${randomBytes(6).toString("hex")}`;
if (!/^automata_webhooks_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error("Refusing to manage an unexpected database name");
}
const adminUrl = new URL(adminConnectionString);
adminUrl.pathname = "/postgres";
const testUrl = new URL(adminConnectionString);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
let databaseClient;
let inspect;
let telemetry;

const hash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const environment = {
  AUTOMATA_PROFILE: "test",
  CKB_NETWORK: "ckb_dev",
  CKB_GENESIS_HASH: hash(1),
  CKB_RPC_URL: "http://127.0.0.1:8114/",
  CKB_INDEXER_URL: "http://127.0.0.1:8116/",
  DATABASE_URL: testUrl.href,
  REDIS_URL: "redis://127.0.0.1:6379/",
  PUBLIC_APP_ORIGIN: "https://automata.example.test",
  WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
};

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
  await inspect`
    INSERT INTO indexer_checkpoints (network_id, block_number, block_hash)
    VALUES ('ckb_dev', 3, ${hash(2)})
  `;
  databaseClient = createDatabaseClient(testUrl.href);
  telemetry = new BackendTelemetry(environment, { writer: () => undefined });
  const auth = new AuthService(databaseClient.database, environment);
  const owner = await createSession(auth, hash(7), hash(17));
  const otherOwner = await createSession(auth, hash(8), hash(18));
  const jobId = hash(31);
  await inspect`
    INSERT INTO jobs (
      network_id, job_id, outpoint_tx_hash, outpoint_index, sequence,
      owner_lock_hash, policy_script_hash, policy_kind, state, capacity,
      data, block_number, block_hash, transaction_index
    ) VALUES (
      'ckb_dev', ${jobId}, ${hash(32)}, 0, 0,
      ${owner.ownerLockHash}, ${hash(33)}, 'recurring', 'live', 10000000000,
      decode('00', 'hex'), 1, ${hash(34)}, 0
    )
  `;
  const eventIds = [];
  for (let fixture = 1; fixture <= 6; fixture += 1) {
    const [{ id }] = await inspect`
      INSERT INTO job_events (
        network_id, job_id, event_type, source, payload, occurred_at, created_at
      ) VALUES (
        'ckb_dev', ${jobId}, ${`test_event_${fixture}`}, 'operational',
        '{}'::jsonb, '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z'
      )
      RETURNING id
    `;
    eventIds.push(BigInt(id));
  }
  const [successEvent, timeoutEvent, retryEvent, permanentEvent, duplicateEvent, rotationEvent] =
    eventIds;
  assert.ok(
    successEvent && timeoutEvent && retryEvent && permanentEvent && duplicateEvent && rotationEvent,
  );
  await inspect`
    INSERT INTO job_events (
      network_id, job_id, event_type, source, payload, occurred_at, created_at
    ) VALUES (
      'ckb_dev', ${jobId}, 'execution_ready', 'operational',
      '{}'::jsonb, '2026-09-23T00:01:00Z', '2026-09-23T00:01:00Z'
    )
  `;
  const metricsController = new MetricsController(telemetry, databaseClient, {
    getTipHeader: async () => ({ number: 5n }),
  });
  const readyMetrics = await metricsController.get();
  assert.match(readyMetrics, /automata_jobs_live_total 1/);
  assert.match(readyMetrics, /automata_jobs_ready_total 1/);
  assert.match(readyMetrics, /automata_indexer_tip_lag_blocks 2/);
  await inspect`
    INSERT INTO job_events (
      network_id, job_id, event_type, source, payload, occurred_at, created_at
    ) VALUES (
      'ckb_dev', ${jobId}, 'execution_submitted', 'operational',
      '{}'::jsonb, '2026-09-23T00:02:00Z', '2026-09-23T00:02:00Z'
    )
  `;
  const submittedMetrics = await metricsController.get();
  assert.match(submittedMetrics, /automata_jobs_ready_total 0/);

  let currentTime = Date.parse("2026-09-23T01:00:00Z");
  let mode = "success";
  const requests = [];
  let releaseDuplicate;
  let duplicateStarted;
  const duplicateStartedPromise = new Promise((resolve) => {
    duplicateStarted = resolve;
  });
  const fetchStub = async (input, init) => {
    const request = new globalThis.Request(input, init);
    requests.push(request);
    if (mode === "timeout") {
      return new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      });
    }
    if (mode === "transient") return new globalThis.Response("retry", { status: 503 });
    if (mode === "permanent") return new globalThis.Response("invalid", { status: 400 });
    if (mode === "duplicate") {
      duplicateStarted();
      await new Promise((resolve) => {
        releaseDuplicate = resolve;
      });
    }
    return new globalThis.Response("accepted", { status: 202 });
  };
  const webhooks = new WebhookService(databaseClient.database, auth, environment, {
    fetch: fetchStub,
    now: () => new Date(currentTime),
    resolveHostname: async () => [{ address: "203.0.113.10" }],
    timeoutMs: 15,
    metrics: telemetry.metrics,
  });

  await assert.rejects(
    () =>
      webhooks.register(owner.authorization, {
        endpoint: "https://127.0.0.1/internal",
        eventTypes: ["confirmed"],
      }),
    (error) => error?.getResponse?.().code === "INVALID_WEBHOOK_REQUEST",
  );
  const registration = await webhooks.register(owner.authorization, {
    endpoint: "https://hooks.example.test/automata",
    eventTypes: [
      "ready",
      "submitted",
      "confirmed",
      "failed",
      "budget_low",
      "cancelled",
      "recovery_required",
    ],
  });
  assert.match(registration.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(registration.secretVersion, 1);
  const [stored] = await inspect`
    SELECT destination_ciphertext, secret_version
    FROM notification_subscriptions
    WHERE id = ${registration.id}
  `;
  assert.equal(stored.destination_ciphertext.includes(registration.secret), false);
  assert.equal(stored.destination_ciphertext.includes("hooks.example.test"), false);
  assert.equal(stored.secret_version, 1);

  const first = await webhooks.deliver(registration.id, successEvent, "confirmed");
  assert.equal(first.status, "delivered");
  assert.equal(first.attemptNumber, 1);
  const firstRequest = requests.at(-1);
  const firstBody = await firstRequest.clone().text();
  assert.equal(firstRequest.headers.get("x-automata-delivery"), first.idempotencyKey);
  assert.equal(
    verifyWebhookSignature(
      registration.secret,
      firstRequest.headers.get("x-automata-timestamp"),
      firstBody,
      firstRequest.headers.get("x-automata-signature"),
    ),
    true,
  );
  const payload = JSON.parse(firstBody);
  assert.equal(payload.kind, "notification");
  assert.equal(payload.proof, null);
  assert.equal("transaction" in payload, false);

  mode = "timeout";
  const timedOut = await webhooks.deliver(registration.id, timeoutEvent, "submitted");
  assert.equal(timedOut.status, "retry_scheduled");
  assert.equal(timedOut.errorCode, "WEBHOOK_TIMEOUT");

  mode = "transient";
  const transient = await webhooks.deliver(registration.id, retryEvent, "failed");
  assert.equal(transient.status, "retry_scheduled");
  for (const delay of [60_000, 300_000, 1_800_000]) {
    currentTime += delay;
    await webhooks.retryDue(10);
  }
  const retryRows = await inspect`
    SELECT attempt_number, idempotency_key, status, next_attempt_at
    FROM webhook_deliveries
    WHERE subscription_id = ${registration.id} AND event_id = ${retryEvent}
    ORDER BY attempt_number
  `;
  assert.equal(retryRows.length, 4);
  assert.ok(retryRows.every(({ idempotency_key }) => idempotency_key === transient.idempotencyKey));
  assert.equal(retryRows.at(-1).status, "failed");
  assert.equal(retryRows.at(-1).next_attempt_at, null);

  mode = "permanent";
  const permanent = await webhooks.deliver(registration.id, permanentEvent, "failed");
  assert.equal(permanent.status, "failed");
  assert.equal(permanent.errorCode, "WEBHOOK_PERMANENT_HTTP");
  assert.equal(permanent.nextAttemptAt, null);

  mode = "duplicate";
  const requestCountBeforeDuplicate = requests.length;
  const originalPromise = webhooks.deliver(registration.id, duplicateEvent, "ready");
  await duplicateStartedPromise;
  const duplicate = await webhooks.deliver(registration.id, duplicateEvent, "ready");
  assert.equal(duplicate.status, "pending");
  assert.equal(requests.length, requestCountBeforeDuplicate + 1);
  releaseDuplicate();
  const original = await originalPromise;
  assert.equal(original.status, "delivered");

  mode = "success";
  const rotation = await webhooks.rotateSecret(owner.authorization, registration.id);
  assert.equal(rotation.secretVersion, 2);
  assert.notEqual(rotation.secret, registration.secret);
  const rotatedDelivery = await webhooks.deliver(registration.id, rotationEvent, "confirmed");
  const rotatedRequest = requests.at(-1);
  const rotatedBody = await rotatedRequest.clone().text();
  assert.equal(
    verifyWebhookSignature(
      rotation.secret,
      rotatedRequest.headers.get("x-automata-timestamp"),
      rotatedBody,
      rotatedRequest.headers.get("x-automata-signature"),
    ),
    true,
  );
  assert.equal(
    verifyWebhookSignature(
      registration.secret,
      rotatedRequest.headers.get("x-automata-timestamp"),
      rotatedBody,
      rotatedRequest.headers.get("x-automata-signature"),
    ),
    false,
  );

  const replay = await webhooks.replay(owner.authorization, registration.id, first.id);
  assert.equal(replay.replayNumber, 1);
  assert.notEqual(replay.idempotencyKey, first.idempotencyKey);
  assert.equal(replay.status, "delivered");
  const concurrentReplays = await Promise.all([
    webhooks.replay(owner.authorization, registration.id, first.id),
    webhooks.replay(owner.authorization, registration.id, first.id),
  ]);
  assert.deepEqual(
    concurrentReplays
      .map(({ replayNumber }) => replayNumber)
      .toSorted((left, right) => left - right),
    [2, 3],
  );
  assert.notEqual(concurrentReplays[0].idempotencyKey, concurrentReplays[1].idempotencyKey);
  const history = await webhooks.history(owner.authorization, registration.id, { limit: "100" });
  assert.ok(history.items.some(({ id }) => id === rotatedDelivery.id));
  assert.ok(history.items.some(({ id }) => id === replay.id));
  await assert.rejects(
    () => webhooks.history(otherOwner.authorization, registration.id, {}),
    (error) => error?.getStatus?.() === 404,
  );

  mode = "transient";
  const scheduledReplay = await webhooks.replay(
    owner.authorization,
    registration.id,
    rotatedDelivery.id,
  );
  assert.equal(scheduledReplay.status, "retry_scheduled");
  const disabled = await webhooks.update(owner.authorization, registration.id, { enabled: false });
  assert.equal(disabled.enabled, false);
  const [cancelledRetry] = await inspect`
    SELECT status, error_code, next_attempt_at
    FROM webhook_deliveries
    WHERE id = ${scheduledReplay.id}
  `;
  assert.equal(cancelledRetry.status, "failed");
  assert.equal(cancelledRetry.error_code, "WEBHOOK_DISABLED");
  assert.equal(cancelledRetry.next_attempt_at, null);
  await assert.rejects(
    () => webhooks.deliver(registration.id, rotationEvent, "confirmed"),
    (error) => error?.getResponse?.().code === "WEBHOOK_UNAVAILABLE",
  );
  await assert.rejects(
    () => webhooks.replay(owner.authorization, registration.id, first.id),
    (error) => error?.getResponse?.().code === "WEBHOOK_UNAVAILABLE",
  );
  const renderedMetrics = await telemetry.metrics.render();
  assert.match(renderedMetrics, /automata_webhook_deliveries_total\{outcome="delivered"\} 6/);
  assert.match(renderedMetrics, /automata_webhook_deliveries_total\{outcome="failed"\} 3/);
  assert.match(renderedMetrics, /automata_webhook_deliveries_total\{outcome="retry_scheduled"\} 7/);

  console.log(
    "Telemetry verified: live/readiness/index-lag metrics plus signed webhook delivery outcomes",
  );
} finally {
  await telemetry?.onModuleDestroy();
  await databaseClient?.close();
  await inspect?.end({ timeout: 2 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 2 });
}
