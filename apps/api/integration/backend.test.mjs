import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";

import { Queue, Worker } from "bullmq";
import { Script, SignerCkbPrivateKey } from "@ckb-ccc/shell";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { rawTransactionToHash, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";
import postgres from "postgres";

import { buildRecurringCreation, deploymentRegistry } from "@ckb-automata/core";

import { installFastifyAbuseControls } from "../src/abuse-controls.ts";
import { createAppModule } from "../src/app.module.ts";
import { AuthService } from "../src/auth.ts";
import { createApiApplication } from "../src/bootstrap.ts";
import { DatabaseClient } from "../src/database/client.ts";
import { migrateDatabase } from "../src/database/migrator.ts";
import { JobEventStreamController } from "../src/events.ts";
import { CanonicalBlockProjector } from "../src/indexer/reorg.ts";
import { BackendTelemetry } from "../src/telemetry.ts";
import { WebhookService } from "../src/webhooks.ts";
import { LOCAL_PRIVATE_KEY, toRpcTransaction } from "../../../scripts/lib/ckb-local.mjs";

const databaseUrl = process.env["AUTOMATA_INTEGRATION_DATABASE_URL"];
const redisUrl = process.env["AUTOMATA_INTEGRATION_REDIS_URL"];
if (!databaseUrl || !redisUrl) {
  throw new Error(
    "AUTOMATA_INTEGRATION_DATABASE_URL and AUTOMATA_INTEGRATION_REDIS_URL are required",
  );
}

const [genesisHash] = deploymentRegistry.genesisHashes;
assert.ok(genesisHash);
const loaded = await deploymentRegistry.load(genesisHash);
assert.equal(loaded.status, "ok");
if (loaded.status !== "ok") throw new Error("local deployment fixture is unavailable");
const deployment = loaded.deployment;
const deadlineFixture = JSON.parse(
  await readFile(
    new URL("../../../contracts/fixtures/deadline_creation_v1.json", import.meta.url),
    "utf8",
  ),
);
const openApiDocument = JSON.parse(
  await readFile(new URL("../../../packages/api-client/openapi.json", import.meta.url), "utf8"),
);
const COVERED_OPERATIONS = Object.freeze([
  "AccountJobsController_list",
  "ActivityController_list",
  "AuthController_current",
  "AuthController_issue",
  "AuthController_revoke",
  "AuthController_verify",
  "HealthController_live",
  "HealthController_ready",
  "JobEventsController_list",
  "JobEventStreamController_stream",
  "JobQuoteController_get",
  "JobsController_detail",
  "JobsController_list",
  "MetricsController_get",
  "NetworkMetadataController_get",
  "NotificationPreferencesController_get",
  "NotificationPreferencesController_reset",
  "NotificationPreferencesController_update",
  "TemplatesController_list",
  "TransactionController_cancel",
  "TransactionController_createDeadline",
  "TransactionController_createRecurring",
  "TransactionController_recover",
  "TransactionController_topUp",
  "TransactionController_validateSigned",
  "TransactionProgressController_get",
  "TransactionProgressController_stream",
  "WebhookController_history",
  "WebhookController_list",
  "WebhookController_register",
  "WebhookController_replay",
  "WebhookController_rotate",
  "WebhookController_update",
]);

const quietLogger = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};
const hash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

function responseJson(response) {
  const contentType = response.headers["content-type"] ?? "";
  return contentType.includes("json") ? response.json() : response.body;
}

function rpcHeader(number, blockHash, parentHash) {
  return {
    compact_target: "0x20010000",
    dao: hash(0),
    epoch: "0x1000000000001",
    extra_hash: hash(4),
    hash: blockHash,
    nonce: `0x${"00".repeat(16)}`,
    number: `0x${number.toString(16)}`,
    parent_hash: parentHash,
    proposals_hash: hash(5),
    timestamp: "0x1a3185c5000",
    transactions_root: hash(6),
    version: "0x0",
  };
}

async function openRpcMock({ sourceBlockHash, sourceTransaction, sourceTxHash }) {
  const state = { available: true, requests: [] };
  const tip = rpcHeader(50, hash(50), hash(49));
  const server = createServer(async (incoming, response) => {
    let raw = "";
    for await (const chunk of incoming) raw += chunk;
    const payload = JSON.parse(raw);
    state.requests.push(payload.method);
    response.setHeader("content-type", "application/json");
    if (!state.available) {
      response.end(
        JSON.stringify({
          id: payload.id,
          jsonrpc: "2.0",
          error: { code: -32_000, message: "integration outage" },
        }),
      );
      return;
    }
    let result;
    switch (payload.method) {
      case "get_block_hash":
        result =
          BigInt(payload.params[0]) === 0n ? genesisHash : hash(Number(BigInt(payload.params[0])));
        break;
      case "get_block_by_number": {
        const number = Number(BigInt(payload.params[0]));
        result = {
          header: rpcHeader(number, hash(number), hash(Math.max(0, number - 1))),
          proposals: [],
          transactions: [],
          uncles: [],
        };
        break;
      }
      case "get_tip_header":
        result = tip;
        break;
      case "get_tip":
        result = { block_number: tip.number, block_hash: tip.hash };
        break;
      case "get_transaction":
        result =
          payload.params[0] === sourceTxHash
            ? {
                transaction: toRpcTransaction(sourceTransaction),
                tx_status: { status: "committed", block_hash: sourceBlockHash },
              }
            : { transaction: null, tx_status: { status: "unknown" } };
        break;
      case "test_tx_pool_accept":
        result = { cycles: "0x309" };
        break;
      default:
        response.end(
          JSON.stringify({
            id: payload.id,
            jsonrpc: "2.0",
            error: { code: -32_601, message: "unsupported integration RPC method" },
          }),
        );
        return;
    }
    response.end(JSON.stringify({ id: payload.id, jsonrpc: "2.0", result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock RPC did not bind");
  return {
    state,
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function redisConnection() {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    maxRetriesPerRequest: null,
  };
}

async function waitForJobState(job, expected) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const state = await job.getState();
    if (state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`job ${job.id} did not reach ${expected}`);
}

async function verifyDurableQueue(runId) {
  const prefix = `automata-integration-${runId}`;
  const connection = redisConnection();
  const publisher = new Queue("probe", { connection, prefix });
  const successful = await publisher.add(
    "success",
    { jobId: hash(71) },
    { jobId: "stable-success", removeOnComplete: false },
  );
  const duplicate = await publisher.add(
    "success",
    { jobId: hash(71) },
    { jobId: "stable-success", removeOnComplete: false },
  );
  assert.equal(duplicate.id, successful.id);
  await publisher.close();

  const resumed = new Queue("probe", { connection, prefix });
  const resumedSuccessful = await resumed.getJob("stable-success");
  assert.ok(resumedSuccessful);
  const failed = await resumed.add(
    "failure",
    { jobId: hash(72) },
    { attempts: 1, jobId: "stable-failure", removeOnFail: false },
  );
  const worker = new Worker(
    "probe",
    async (job) => {
      if (job.name === "failure") throw new Error("expected integration failure");
      return { accepted: true };
    },
    { connection, prefix },
  );
  try {
    await worker.waitUntilReady();
    await waitForJobState(resumedSuccessful, "completed");
    await waitForJobState(failed, "failed");
    const completed = await resumed.getJob("stable-success");
    const terminalFailure = await resumed.getJob("stable-failure");
    assert.deepEqual(completed?.returnvalue, { accepted: true });
    assert.equal(terminalFailure?.attemptsMade, 1);
  } finally {
    await worker.close();
    await resumed.obliterate({ force: true });
    await resumed.close();
  }
}

function createRecurringFixture() {
  const ownerLock = {
    codeHash: deployment.manifest.secp256k1Blake160.codeHash,
    hashType: deployment.manifest.secp256k1Blake160.hashType,
    args: deployment.manifest.fixtureWallet.lockArg,
  };
  const ownerLockHash = scriptToHash(ownerLock);
  const requestBody = {
    ownerLockHash,
    recipientLockHash: ownerLockHash,
    lockResolutions: [ownerLock],
    amount: "10000000000",
    intervalBlocks: "10",
    firstNotBefore: "100",
    totalRuns: "3",
    reward: "10000000000",
    creatorNonce: "71",
  };
  const creation = buildRecurringCreation({
    deployment,
    ...requestBody,
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "800" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  return { creation, ownerLock, ownerLockHash, requestBody };
}

async function createDatabase(scenario) {
  const suffix = randomBytes(6).toString("hex");
  const databaseName = `automata_integration_${scenario}_${suffix}`;
  if (!/^automata_integration_(fresh|upgraded)_[0-9a-f]{12}$/.test(databaseName)) {
    throw new Error("refusing to manage an unexpected integration database");
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    if (scenario === "upgraded") {
      await migrateDatabase({ connectionString: testUrl.href, targetVersion: 3 });
    }
    await migrateDatabase({ connectionString: testUrl.href });
    return { admin, databaseName, testUrl };
  } catch (error) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end({ timeout: 2 });
    throw error;
  }
}

async function createComposedApp(environment, webhookRequests) {
  const result = await createApiApplication(environment, {
    logger: quietLogger,
    createApplication: async (logger, config) => {
      const applicationModule = createAppModule(config.environment);
      const providers = applicationModule.providers.map((provider) => {
        if (!provider || typeof provider !== "object" || provider.provide !== WebhookService) {
          return provider;
        }
        return {
          provide: WebhookService,
          inject: [DatabaseClient, AuthService, BackendTelemetry],
          useFactory: (database, auth, telemetry) =>
            new WebhookService(database.database, auth, config.environment, {
              fetch: async (input, init) => {
                webhookRequests.push(new globalThis.Request(input, init));
                return new globalThis.Response("accepted", { status: 202 });
              },
              metrics: telemetry.metrics,
              resolveHostname: async () => [{ address: "203.0.113.10" }],
            }),
        };
      });
      const adapter = new FastifyAdapter();
      installFastifyAbuseControls(adapter.getInstance(), config);
      return NestFactory.create({ ...applicationModule, providers }, adapter, {
        abortOnError: true,
        bufferLogs: true,
        logger,
      });
    },
  });
  await result.app.init();
  return result.app;
}

async function request(fastify, method, url, options = {}) {
  const response = await fastify.inject({ method, url, ...options });
  return {
    body: responseJson(response),
    headers: response.headers,
    status: response.statusCode,
  };
}

async function verifySse(app, jobId) {
  const controller = app.get(JobEventStreamController);
  assert.throws(() =>
    controller.stream("invalid", undefined, undefined, new globalThis.AbortController().signal),
  );
  const abort = new globalThis.AbortController();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE integration event timed out")), 3_000);
    const subscription = controller.stream(jobId, undefined, undefined, abort.signal).subscribe({
      next: (event) => {
        if (!event.data) return;
        try {
          assert.equal(event.data.jobId, jobId);
          assert.equal(event.data.eventType, "job_discovered");
          clearTimeout(timer);
          abort.abort();
          subscription.unsubscribe();
          resolve();
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      },
      error: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

async function runComposedSuite(scenario) {
  const database = await createDatabase(scenario);
  let inspect;
  let rpc;
  let app;
  try {
    const recurring = createRecurringFixture();
    const sourceBlockHash = hash(42);
    const sourceTxHash = rawTransactionToHash(recurring.creation.transaction);
    rpc = await openRpcMock({
      sourceBlockHash,
      sourceTransaction: recurring.creation.transaction,
      sourceTxHash,
    });
    inspect = postgres(database.testUrl.href, { max: 1, onnotice: () => undefined });
    const webhookRequests = [];
    await inspect`
      INSERT INTO networks (
        id, genesis_hash, rpc_profile, confirmation_depth, deployment_manifest_hash
      ) VALUES (
        ${deployment.network}, ${deployment.genesisHash}, 'local',
        ${deployment.confirmation.requiredDepth}, ${deployment.manifestSha256}
      )
    `;
    const environment = {
      AUTOMATA_PROFILE: "test",
      CKB_NETWORK: deployment.network,
      CKB_GENESIS_HASH: deployment.genesisHash,
      CKB_RPC_URL: rpc.url,
      CKB_INDEXER_URL: rpc.url,
      DATABASE_URL: database.testUrl.href,
      REDIS_URL: redisUrl,
      PUBLIC_APP_ORIGIN: "https://automata.example.test",
      WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
    };
    app = await createComposedApp(environment, webhookRequests);
    const fastify = app.getHttpAdapter().getInstance();
    const projector = app.get(CanonicalBlockProjector);
    const sourceBlock = {
      header: {
        number: 42n,
        hash: sourceBlockHash,
        parentHash: hash(41),
        timestamp: 1_800_000_000_000n,
      },
      transactions: [{ ...recurring.creation.transaction, hash: () => sourceTxHash }],
    };
    const indexed = await projector.projectBlock(sourceBlock, deployment);
    assert.equal(indexed.discovery.insertedJobs, 1);
    const replayed = await projector.projectBlock(sourceBlock, deployment);
    assert.equal(replayed.discovery.insertedJobs, 0);
    assert.equal(replayed.checkpoint.status, "unchanged");
    const recoveredGap = await projector.projectBlock(
      {
        header: {
          number: 44n,
          hash: hash(44),
          parentHash: hash(99),
          timestamp: 1_800_000_002_000n,
        },
        transactions: [],
      },
      deployment,
    );
    assert.equal(recoveredGap.rollback?.rolledBackBlocks, 0);
    assert.equal(recoveredGap.checkpoint.checkpoint.blockNumber, 44n);

    assert.equal((await request(fastify, "GET", "/v1/health/live")).status, 200);
    const ready = await request(fastify, "GET", "/v1/health/ready");
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.status, "ready");
    const network = await request(fastify, "GET", "/v1/network");
    assert.equal(network.status, 200);
    assert.equal(network.body.genesisHash, genesisHash);
    const templates = await request(fastify, "GET", "/v1/templates");
    assert.equal(templates.status, 200);
    assert.equal(templates.body.items.length, 2);

    const jobs = await request(fastify, "GET", "/v1/jobs?limit=1");
    assert.equal(jobs.status, 200);
    assert.equal(jobs.body.items[0].jobId, recurring.creation.jobId);
    assert.equal((await request(fastify, "GET", "/v1/jobs?limit=101")).status, 400);
    assert.equal(
      (await request(fastify, "GET", `/v1/jobs/${recurring.creation.jobId}`)).status,
      200,
    );
    assert.equal((await request(fastify, "GET", `/v1/jobs/${hash(88)}`)).status, 404);
    assert.equal(
      (await request(fastify, "GET", `/v1/accounts/${recurring.ownerLockHash}/jobs`)).status,
      200,
    );
    const timeline = await request(fastify, "GET", `/v1/jobs/${recurring.creation.jobId}/events`);
    assert.equal(timeline.status, 200);
    assert.equal(timeline.body.items[0].eventType, "job_discovered");
    await verifySse(app, recurring.creation.jobId);

    const quote = await request(fastify, "GET", `/v1/jobs/${recurring.creation.jobId}/quote`);
    assert.equal(quote.status, 200);
    assert.equal(quote.body.jobId, recurring.creation.jobId);
    assert.equal((await request(fastify, "GET", `/v1/jobs/${hash(89)}/quote`)).status, 404);

    const recurringCreated = await request(
      fastify,
      "POST",
      "/v1/transactions/create-recurring-job",
      { payload: recurring.requestBody },
    );
    assert.equal(recurringCreated.status, 200);
    assert.equal(recurringCreated.body.protocolIntentHash, recurring.creation.intentHash);
    const successLock = { ...recurring.ownerLock, args: "0x1234" };
    const deadlineCreated = await request(fastify, "POST", "/v1/transactions/create-deadline-job", {
      payload: {
        pledges: deadlineFixture.pledges.map((pledge) => ({
          outPoint: { txHash: pledge.tx_hash, index: pledge.index },
          refundLockHash: recurring.ownerLockHash,
          amount: pledge.amount,
        })),
        target: deadlineFixture.target,
        deadlineBlock: deadlineFixture.deadline_block,
        successLockHash: scriptToHash(successLock),
        cancelLockHash: recurring.ownerLockHash,
        reward: deadlineFixture.reward,
        creatorNonce: deadlineFixture.creator_nonce,
        lockResolutions: [recurring.ownerLock, successLock],
      },
    });
    assert.equal(deadlineCreated.status, 200);
    const ownerRequest = {
      jobId: recurring.creation.jobId,
      quoteId: quote.body.quoteId,
      ownerLock: recurring.ownerLock,
    };
    const cancellation = await request(fastify, "POST", "/v1/transactions/cancel-job", {
      payload: ownerRequest,
    });
    assert.equal(cancellation.status, 200);
    const recovery = await request(fastify, "POST", "/v1/transactions/recover-job", {
      payload: { ...ownerRequest, reason: "terminal_operational_failure" },
    });
    assert.equal(recovery.status, 200);
    const topUp = await request(fastify, "POST", "/v1/transactions/top-up-job", {
      payload: {
        ...ownerRequest,
        rewardIncrease: "0",
        budgetIncrease: "10000000000",
        capacityIncrease: "10000000000",
      },
    });
    assert.equal(topUp.status, 200);
    const completedCancellation = {
      ...cancellation.body.transaction,
      inputs: [
        ...cancellation.body.transaction.inputs,
        { since: "0x0", previousOutput: { txHash: hash(90), index: "0x0" } },
      ],
      witnesses: [...cancellation.body.transaction.witnesses, "0x"],
    };
    const validated = await request(fastify, "POST", "/v1/transactions/validate-signed", {
      payload: {
        operation: "cancel_job",
        request: ownerRequest,
        intentHash: cancellation.body.intentHash,
        policyCriticalHash: cancellation.body.policyCriticalHash,
        transaction: completedCancellation,
      },
    });
    assert.equal(validated.status, 200);
    assert.equal(validated.body.dryRunCycles, "777");
    assert.equal(
      (
        await request(fastify, "POST", "/v1/transactions/create-recurring-job", {
          payload: {},
        })
      ).status,
      400,
    );

    const authSigner = new SignerCkbPrivateKey({}, LOCAL_PRIVATE_KEY);
    const authLock = Script.from(recurring.ownerLock);
    assert.equal(authLock.hash(), recurring.ownerLockHash);
    const challenge = await request(fastify, "POST", "/v1/auth/challenge", {
      payload: { ownerLockHash: authLock.hash() },
    });
    assert.equal(challenge.status, 201);
    const signature = await authSigner.signMessage(challenge.body.message);
    const session = await request(fastify, "POST", "/v1/auth/verify", {
      payload: {
        challengeId: challenge.body.challengeId,
        nonce: challenge.body.nonce,
        ownerLock: {
          args: authLock.args,
          codeHash: authLock.codeHash,
          hashType: authLock.hashType,
        },
        signature,
      },
    });
    assert.equal(session.status, 201);
    const authorization = `Bearer ${session.body.sessionToken}`;
    assert.equal(
      (
        await request(fastify, "GET", "/v1/auth/session", {
          headers: { authorization },
        })
      ).status,
      200,
    );
    assert.equal((await request(fastify, "GET", "/v1/auth/session")).status, 401);

    const preferences = await request(fastify, "PUT", "/v1/preferences", {
      headers: { authorization },
      payload: {
        browser: { enabled: true, eventTypes: ["ready", "confirmed"] },
        email: {
          enabled: true,
          eventTypes: ["failed"],
          address: "owner@example.test",
        },
      },
    });
    assert.equal(preferences.status, 200);
    assert.equal(preferences.body.channels.email.address, "o***@example.test");
    assert.equal(
      (
        await request(fastify, "GET", "/v1/preferences", {
          headers: { authorization },
        })
      ).status,
      200,
    );
    assert.equal((await request(fastify, "GET", "/v1/preferences")).status, 401);

    const webhook = await request(fastify, "POST", "/v1/webhooks", {
      headers: { authorization },
      payload: {
        endpoint: "https://hooks.example.test/integration",
        eventTypes: ["confirmed"],
      },
    });
    assert.equal(webhook.status, 201);
    assert.match(webhook.body.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      (
        await request(fastify, "GET", "/v1/webhooks", {
          headers: { authorization },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(fastify, "POST", "/v1/webhooks", {
          headers: { authorization },
          payload: { endpoint: "https://127.0.0.1/internal", eventTypes: ["confirmed"] },
        })
      ).status,
      400,
    );
    const [{ id: eventId }] = await inspect`
      SELECT id FROM job_events
      WHERE network_id = ${deployment.network} AND job_id = ${recurring.creation.jobId}
      ORDER BY id LIMIT 1
    `;
    const delivered = await app
      .get(WebhookService)
      .deliver(webhook.body.id, BigInt(eventId), "confirmed");
    assert.equal(delivered.status, "delivered");
    assert.equal(webhookRequests.length, 1);
    const history = await request(fastify, "GET", `/v1/webhooks/${webhook.body.id}/deliveries`, {
      headers: { authorization },
    });
    assert.equal(history.status, 200);
    assert.equal(history.body.items.length, 1);
    assert.equal(
      (
        await request(
          fastify,
          "POST",
          `/v1/webhooks/${webhook.body.id}/deliveries/${delivered.id}/replay`,
          { headers: { authorization } },
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await request(fastify, "POST", `/v1/webhooks/${webhook.body.id}/rotate-secret`, {
          headers: { authorization },
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await request(fastify, "PATCH", `/v1/webhooks/${webhook.body.id}`, {
          headers: { authorization },
          payload: { enabled: true, eventTypes: ["confirmed", "failed"] },
        })
      ).status,
      200,
    );
    assert.equal((await request(fastify, "GET", "/v1/webhooks")).status, 401);

    const metrics = await request(fastify, "GET", "/v1/metrics");
    assert.equal(metrics.status, 200);
    assert.match(metrics.body, /automata_jobs_live_total 1/);
    assert.match(metrics.body, /automata_webhook_deliveries_total\{outcome="delivered"\} 2/);

    rpc.state.available = false;
    assert.equal((await request(fastify, "GET", "/v1/network")).status, 503);
    const unavailable = await request(fastify, "GET", "/v1/health/ready");
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.dependencies.rpc.status, "down");
    assert.equal((await request(fastify, "GET", "/v1/health/live")).status, 200);
    assert.ok(rpc.state.requests.includes("get_transaction"));
    assert.ok(rpc.state.requests.includes("test_tx_pool_accept"));

    await verifyDurableQueue(`${scenario}-${randomBytes(4).toString("hex")}`);
  } finally {
    await app?.close();
    await rpc?.close();
    await inspect?.end({ timeout: 2 });
    await database.admin.unsafe(`DROP DATABASE IF EXISTS "${database.databaseName}" WITH (FORCE)`);
    await database.admin.end({ timeout: 2 });
  }
}

test("integration matrix accounts for every public API operation", () => {
  const operations = Object.values(openApiDocument.paths).flatMap((path) =>
    Object.values(path).map(({ operationId }) => operationId),
  );
  assert.deepEqual(operations.toSorted(), [...COVERED_OPERATIONS].toSorted());
});

for (const scenario of ["fresh", "upgraded"]) {
  test(`composed backend passes against a ${scenario} database`, { timeout: 60_000 }, async () => {
    await runComposedSuite(scenario);
  });
}
