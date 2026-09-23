import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";

import { createApiApplication } from "./bootstrap.ts";
import { createOpenApiDocument } from "./openapi.ts";
import { AUTH_SESSION_SCOPE, formatAuthChallengeMessage } from "./auth.ts";

const quietLogger: LoggerService = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

function environment() {
  return {
    AUTOMATA_PROFILE: "local",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: "0x5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3",
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "https://automata.example.test/path",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  } as const;
}

test("challenge messages bind domain, network, owner, lifetime, and settings-only scope", () => {
  const message = formatAuthChallengeMessage({
    challengeId: "018f3f10-7b6a-7cc2-8c7e-1ab2c3d4e5f6",
    domain: "https://automata.example.test",
    expiresAt: new Date("2026-09-22T12:05:00.000Z"),
    issuedAt: new Date("2026-09-22T12:00:00.000Z"),
    network: "ckb_dev",
    nonce: "A".repeat(43),
    ownerLockHash: `0x${"01".repeat(32)}`,
  });

  assert.match(message, /^CKB Automata Off-Chain Authentication v1$/m);
  assert.match(message, /^Domain: https:\/\/automata\.example\.test$/m);
  assert.match(message, /^Network: ckb_dev$/m);
  assert.match(message, new RegExp(`^Scope: ${AUTH_SESSION_SCOPE}$`, "m"));
  assert.match(message, /^Notice: This signature cannot authorize a CKB transaction\.$/m);
});

test("auth contract is settings-only and transaction construction remains unauthenticated", async () => {
  const result = await createApiApplication(environment(), { logger: quietLogger });
  try {
    await result.app.init();
    const document = createOpenApiDocument(result.app);
    const challenge = document.paths["/v1/auth/challenge"]?.post;
    const verify = document.paths["/v1/auth/verify"]?.post;
    const session = document.paths["/v1/auth/session"]?.get;
    const bearer = document.components?.securitySchemes?.["bearer"];
    assert.ok(bearer && !("$ref" in bearer));
    assert.equal(bearer.type, "http");
    assert.ok(challenge?.requestBody && "content" in challenge.requestBody);
    assert.ok(verify?.requestBody && "content" in verify.requestBody);
    assert.ok(session?.security?.some((requirement) => "bearer" in requirement));
    for (const path of [
      "/v1/transactions/create-deadline-job",
      "/v1/transactions/create-recurring-job",
      "/v1/transactions/cancel-job",
      "/v1/transactions/recover-job",
      "/v1/transactions/top-up-job",
      "/v1/transactions/validate-signed",
    ] as const) {
      assert.equal(document.paths[path]?.post?.security, undefined);
    }

    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: {
        method: string;
        payload: unknown;
        url: string;
      }): Promise<{ statusCode: number; json(): unknown }>;
    };
    const malformed = await fastify.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { ownerLockHash: "0x01", unexpected: true },
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal((malformed.json() as { code: string }).code, "INVALID_AUTH_REQUEST");
  } finally {
    await result.app.close();
  }
});
