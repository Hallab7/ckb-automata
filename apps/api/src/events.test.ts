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
    CKB_GENESIS_HASH: "0x5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3",
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

test("event route publishes explicit timeline, provenance, and reference schemas", async () => {
  const result = await createApiApplication(environment(), { logger: quietLogger });
  try {
    await result.app.init();
    const document = SwaggerModule.createDocument(
      result.app,
      new DocumentBuilder().setTitle("CKB Automata API").setVersion("1").build(),
    );
    const operation = document.paths["/v1/jobs/{jobId}/events"]?.get;
    assert.ok(operation);
    const parameters = (operation.parameters ?? []).map((parameter) =>
      "$ref" in parameter ? parameter.$ref : parameter.name,
    );
    assert.deepEqual(parameters.toSorted(), ["cursor", "jobId", "limit", "source"]);
    const response = operation.responses?.["200"];
    assert.ok(response && "content" in response);
    const timeline = response.content?.["application/json"]?.schema;
    assert.ok(timeline && !("$ref" in timeline));
    const items = timeline.properties?.["items"];
    assert.ok(items && !("$ref" in items) && items.items && !("$ref" in items.items));
    const confidence = items.items.properties?.["confidence"];
    assert.ok(confidence && !("$ref" in confidence));
    assert.deepEqual(confidence.enum, ["observed", "committed", "confirmed", "reorged"]);
    const attempt = items.items.properties?.["attempt"];
    assert.ok(attempt && !("$ref" in attempt));
    const receipt = attempt.properties?.["receipt"];
    assert.ok(receipt && !("$ref" in receipt));
    assert.deepEqual(receipt.required, [
      "id",
      "executorLockHash",
      "keyId",
      "signature",
      "payload",
      "createdAt",
    ]);

    const stream = document.paths["/v1/events/stream"]?.get;
    assert.ok(stream);
    const streamParameters = (stream.parameters ?? []).map((parameter) =>
      "$ref" in parameter ? parameter.$ref : parameter.name,
    );
    assert.deepEqual(streamParameters.toSorted(), ["cursor", "jobId"]);
    const streamResponse = stream.responses?.["200"];
    assert.ok(streamResponse && "content" in streamResponse);
    assert.ok(streamResponse.content?.["text/event-stream"]);

    const activity = document.paths["/v1/activity"]?.get;
    assert.ok(activity);
    const activityParameters = (activity.parameters ?? []).map((parameter) =>
      "$ref" in parameter ? parameter.$ref : parameter.name,
    );
    assert.deepEqual(activityParameters.toSorted(), ["cursor", "jobId", "limit", "source"]);
    const activityResponse = activity.responses?.["200"];
    assert.ok(activityResponse && "content" in activityResponse);
    const activityTimeline = activityResponse.content?.["application/json"]?.schema;
    assert.ok(activityTimeline && !("$ref" in activityTimeline));
    assert.deepEqual(activityTimeline.required, ["items", "page", "indexCheckpoint"]);

    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: {
        method: string;
        url: string;
      }): Promise<{ statusCode: number; json(): unknown }>;
    };
    const malformed = await fastify.inject({ method: "GET", url: "/v1/jobs/nope/events" });
    assert.equal(malformed.statusCode, 400);
    assert.equal((malformed.json() as { code: string }).code, "INVALID_HASH");
  } finally {
    await result.app.close();
  }
});
