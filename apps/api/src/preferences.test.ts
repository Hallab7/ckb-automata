import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";

import { createApiApplication } from "./bootstrap.ts";
import { createOpenApiDocument } from "./openapi.ts";
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENT_TYPES } from "./preferences.ts";

const quietLogger: LoggerService = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

const environment = {
  AUTOMATA_PROFILE: "local",
  CKB_NETWORK: "ckb_dev",
  CKB_GENESIS_HASH: "0x5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3",
  CKB_RPC_URL: "http://127.0.0.1:58114",
  CKB_INDEXER_URL: "http://127.0.0.1:58116",
  DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
  REDIS_URL: "redis://127.0.0.1:56379",
  PUBLIC_APP_ORIGIN: "https://automata.example.test",
  WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
} as const;

test("notification preference vocabulary is closed and complete", () => {
  assert.deepEqual(NOTIFICATION_CHANNELS, ["browser", "email"]);
  assert.deepEqual(NOTIFICATION_EVENT_TYPES, [
    "ready",
    "submitted",
    "confirmed",
    "failed",
    "budget_low",
    "cancelled",
    "recovery_required",
  ]);
});

test("preference routes require settings sessions and publish the closed event vocabulary", async () => {
  const result = await createApiApplication(environment, { logger: quietLogger });
  try {
    await result.app.init();
    const document = createOpenApiDocument(result.app);
    const read = document.paths["/v1/preferences"]?.get;
    const update = document.paths["/v1/preferences"]?.put;
    assert.ok(read?.security?.some((requirement) => "bearer" in requirement));
    assert.ok(update?.security?.some((requirement) => "bearer" in requirement));
    assert.ok(update?.requestBody && "content" in update.requestBody);
    const schema = update.requestBody.content["application/json"]?.schema;
    assert.ok(schema && !("$ref" in schema));
    const browser = schema.properties?.["browser"];
    assert.ok(browser && !("$ref" in browser));
    const events = browser.properties?.["eventTypes"];
    assert.ok(events && !("$ref" in events) && events.items && !("$ref" in events.items));
    assert.deepEqual(events.items.enum, [...NOTIFICATION_EVENT_TYPES]);

    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: { method: string; url: string }): Promise<{ statusCode: number }>;
    };
    const unauthorized = await fastify.inject({ method: "GET", url: "/v1/preferences" });
    assert.equal(unauthorized.statusCode, 401);
  } finally {
    await result.app.close();
  }
});
