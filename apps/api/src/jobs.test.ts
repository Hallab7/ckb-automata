import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { createApiApplication } from "./bootstrap.ts";
import { JOB_TEMPLATE_CATALOG } from "./jobs.ts";

const GENESIS_HASH = `0x${"5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3"}`;
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
    CKB_GENESIS_HASH: GENESIS_HASH,
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
  };
}

test("template catalog describes both supported workflows without database state", () => {
  assert.deepEqual(
    JOB_TEMPLATE_CATALOG.map(({ id, execution, triggerMetric, version }) => ({
      id,
      execution,
      triggerMetric,
      version,
    })),
    [
      { id: "deadline", execution: "terminal", triggerMetric: "block", version: 1 },
      { id: "recurring", execution: "recurring", triggerMetric: "block", version: 1 },
    ],
  );
  assert.ok(Object.isFrozen(JOB_TEMPLATE_CATALOG));
});

test("job routes publish an OpenAPI contract with decimal-string integer fields", async () => {
  const result = await createApiApplication(environment(), { logger: quietLogger });
  try {
    await result.app.init();
    const document = SwaggerModule.createDocument(
      result.app,
      new DocumentBuilder().setTitle("CKB Automata API").setVersion("1").build(),
    );
    for (const path of [
      "/v1/templates",
      "/v1/jobs",
      "/v1/jobs/{jobId}",
      "/v1/accounts/{lockHash}/jobs",
    ]) {
      assert.ok(document.paths[path], `missing OpenAPI path ${path}`);
    }

    const listOperation = document.paths["/v1/jobs"]?.get;
    assert.ok(listOperation);
    const parameters = (listOperation.parameters ?? []).map((parameter) =>
      "$ref" in parameter ? parameter.$ref : parameter.name,
    );
    assert.deepEqual(parameters.toSorted(), ["cursor", "limit", "state", "template"]);

    const detailSchema = document.paths["/v1/jobs/{jobId}"]?.get?.responses?.["200"];
    assert.ok(detailSchema && "content" in detailSchema);
    const jsonSchema = detailSchema.content?.["application/json"]?.schema;
    assert.ok(jsonSchema && !("$ref" in jsonSchema));
    const sequence = jsonSchema.properties?.["sequence"];
    assert.ok(sequence && !("$ref" in sequence));
    assert.equal(sequence.type, "string");
    const funds = jsonSchema.properties?.["funds"];
    assert.ok(funds && !("$ref" in funds));
    const capacity = funds.properties?.["capacity"];
    assert.ok(capacity && !("$ref" in capacity));
    assert.equal(capacity.type, "string");
    const source = jsonSchema.properties?.["source"];
    assert.ok(source && !("$ref" in source));
    const block = source.properties?.["block"];
    assert.ok(block && !("$ref" in block));
    const blockNumber = block.properties?.["number"];
    assert.ok(blockNumber && !("$ref" in blockNumber));
    assert.equal(blockNumber.type, "string");

    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: {
        method: string;
        url: string;
      }): Promise<{ statusCode: number; json(): unknown }>;
    };
    assert.equal((await fastify.inject({ method: "GET", url: "/v1/templates" })).statusCode, 200);
    const invalidLimit = await fastify.inject({ method: "GET", url: "/v1/jobs?limit=101" });
    assert.equal(invalidLimit.statusCode, 400);
    assert.equal((invalidLimit.json() as { code: string }).code, "INVALID_JOB_QUERY");
    const invalidOwner = await fastify.inject({ method: "GET", url: "/v1/accounts/nope/jobs" });
    assert.equal(invalidOwner.statusCode, 400);
    assert.equal((invalidOwner.json() as { code: string }).code, "INVALID_HASH");
  } finally {
    await result.app.close();
  }
});
