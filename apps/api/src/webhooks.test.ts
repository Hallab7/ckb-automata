import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";

import { createApiApplication } from "./bootstrap.ts";
import { createOpenApiDocument } from "./openapi.ts";
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  signWebhookRequest,
  verifyWebhookSignature,
} from "./webhooks.ts";

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

test("webhook signatures bind the exact timestamp and body", () => {
  const secret = "B".repeat(43);
  const timestamp = "1790112000";
  const body = '{"kind":"notification","proof":null}';
  const signature = signWebhookRequest(secret, timestamp, body);

  assert.match(signature, /^v1=[0-9a-f]{64}$/);
  assert.equal(verifyWebhookSignature(secret, timestamp, body, signature), true);
  assert.equal(verifyWebhookSignature(secret, `${timestamp}0`, body, signature), false);
  assert.equal(verifyWebhookSignature(secret, timestamp, `${body} `, signature), false);
});

test("webhook retry policy is finite and externally documented", () => {
  assert.equal(WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(WEBHOOK_RETRY_DELAYS_MS, [60_000, 300_000, 1_800_000]);
});

test("webhook routes require owner sessions and expose one-time secret contracts", async () => {
  const result = await createApiApplication(environment, { logger: quietLogger });
  try {
    await result.app.init();
    const document = createOpenApiDocument(result.app);
    const register = document.paths["/v1/webhooks"]?.post;
    const history = document.paths["/v1/webhooks/{subscriptionId}/deliveries"]?.get;
    const replay =
      document.paths["/v1/webhooks/{subscriptionId}/deliveries/{deliveryId}/replay"]?.post;
    assert.ok(register?.security?.some((requirement) => "bearer" in requirement));
    assert.ok(history?.security?.some((requirement) => "bearer" in requirement));
    assert.ok(replay?.security?.some((requirement) => "bearer" in requirement));
    assert.ok(register?.responses?.[201] && "content" in register.responses[201]);
    const responseSchema = register.responses[201].content["application/json"]?.schema;
    assert.ok(responseSchema && !("$ref" in responseSchema));
    assert.ok(responseSchema.properties?.["secret"]);

    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: { method: string; url: string }): Promise<{ statusCode: number }>;
    };
    const unauthorized = await fastify.inject({ method: "GET", url: "/v1/webhooks" });
    assert.equal(unauthorized.statusCode, 401);
  } finally {
    await result.app.close();
  }
});
