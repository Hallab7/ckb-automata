import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { createApiApplication } from "./bootstrap.ts";

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
    CKB_GENESIS_HASH: `0x${"1".repeat(64)}`,
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

test("quote route documents every chain integer as a decimal string", async () => {
  const result = await createApiApplication(environment(), { logger: quietLogger });
  try {
    await result.app.init();
    const document = SwaggerModule.createDocument(
      result.app,
      new DocumentBuilder().setTitle("CKB Automata API").setVersion("1").build(),
    );
    const response = document.paths["/v1/jobs/{jobId}/quote"]?.get?.responses?.["200"];
    assert.ok(response && "content" in response);
    const schema = response.content?.["application/json"]?.schema;
    assert.ok(schema && !("$ref" in schema));

    const amounts = schema.properties?.["amounts"];
    assert.ok(amounts && !("$ref" in amounts));
    for (const field of [
      "remainingBudget",
      "residualRefund",
      "retainedTerminalCapacity",
      "currentLockedTotal",
    ]) {
      const value = amounts.properties?.[field] as { type?: string } | undefined;
      assert.ok(value && !("$ref" in value));
      assert.equal(value.type, "string");
    }
    const schedule = schema.properties?.["schedule"];
    assert.ok(schedule && !("$ref" in schedule));
    const earliestBlock = schedule.properties?.["earliestBlock"];
    assert.ok(earliestBlock && !("$ref" in earliestBlock));
    assert.equal(earliestBlock.type, "string");

    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: {
        method: string;
        url: string;
      }): Promise<{ statusCode: number; json(): unknown }>;
    };
    const malformed = await fastify.inject({ method: "GET", url: "/v1/jobs/nope/quote" });
    assert.equal(malformed.statusCode, 400);
    assert.equal((malformed.json() as { code: string }).code, "INVALID_HASH");
  } finally {
    await result.app.close();
  }
});
