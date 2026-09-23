import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { createApiApplication } from "./bootstrap.ts";
import { CkbClientError } from "./ckb-client.ts";
import { TransactionBuildService } from "./transactions.ts";

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
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

test("transaction routes publish construction and signed-validation contracts", async () => {
  const result = await createApiApplication(environment(), { logger: quietLogger });
  try {
    await result.app.init();
    const document = SwaggerModule.createDocument(
      result.app,
      new DocumentBuilder().setTitle("CKB Automata API").setVersion("1").build(),
    );
    for (const path of [
      "/v1/transactions/create-deadline-job",
      "/v1/transactions/create-recurring-job",
      "/v1/transactions/cancel-job",
      "/v1/transactions/recover-job",
      "/v1/transactions/top-up-job",
      "/v1/transactions/validate-signed",
    ]) {
      assert.ok(document.paths[path]?.post, `missing POST contract for ${path}`);
    }

    const response =
      document.paths["/v1/transactions/create-recurring-job"]?.post?.responses?.["200"];
    assert.ok(response && "content" in response);
    const schema = response.content?.["application/json"]?.schema;
    assert.ok(schema && !("$ref" in schema));
    for (const property of [
      "transaction",
      "signingEntries",
      "intent",
      "intentHash",
      "policyCriticalHash",
      "chainSnapshot",
      "quoteExpiry",
    ]) {
      assert.ok(schema.properties?.[property], `missing response property ${property}`);
    }

    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: {
        method: string;
        url: string;
        payload: unknown;
      }): Promise<{ statusCode: number; json(): unknown }>;
    };
    const malformed = await fastify.inject({
      method: "POST",
      url: "/v1/transactions/create-recurring-job",
      payload: { ownerLockHash: "nope" },
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal((malformed.json() as { code: string }).code, "INVALID_TRANSACTION_REQUEST");
    const malformedValidation = await fastify.inject({
      method: "POST",
      url: "/v1/transactions/validate-signed",
      payload: {},
    });
    assert.equal(malformedValidation.statusCode, 400);
    assert.equal(
      (malformedValidation.json() as { code: string }).code,
      "INVALID_TRANSACTION_REQUEST",
    );
  } finally {
    await result.app.close();
  }
});

test("chain read failures remain service outages instead of request errors", async () => {
  const service = new TransactionBuildService(
    {} as never,
    {
      getTipHeader: async () => {
        throw new CkbClientError("CHAIN_READ_FAILED", "chain unavailable");
      },
    } as never,
    environment().CKB_GENESIS_HASH,
  );
  await assert.rejects(
    service.construct("create_recurring_job", {
      ownerLockHash: `0x${"1".repeat(64)}`,
      recipientLockHash: `0x${"2".repeat(64)}`,
      amount: "10000000000",
      intervalBlocks: "10",
      firstNotBefore: "500",
      totalRuns: "2",
      reward: "10000000000",
      creatorNonce: "1",
    }),
    (error: unknown) => {
      assert.equal(
        (error as { getStatus(): number; getResponse(): { code: string } }).getStatus(),
        503,
      );
      assert.equal(
        (error as { getResponse(): { code: string } }).getResponse().code,
        "CHAIN_READ_FAILED",
      );
      return true;
    },
  );
});
