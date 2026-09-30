import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { createApiApplication } from "./bootstrap.ts";
import { DAO_HARVEST_READ_STATES, DaoHarvestMutationService } from "./dao-harvest.ts";

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

test("DAO harvest API publishes read, quote, and unsigned mutation routes", async () => {
  const { app } = await createApiApplication(environment(), { logger: quietLogger });
  try {
    await app.init();
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    for (const path of [
      "/v1/dao-harvest",
      "/v1/dao-harvest/{jobId}",
      "/v1/dao-harvest/{jobId}/quote",
      "/v1/dao-harvest/setup",
      "/v1/dao-harvest/stop",
      "/v1/dao-harvest/exit",
      "/v1/dao-harvest/recover",
    ]) {
      assert.ok(document.paths[path], `missing OpenAPI path ${path}`);
    }
    const schema = document.paths["/v1/dao-harvest/{jobId}"]?.get?.responses?.["200"];
    assert.match(JSON.stringify(schema), /principal/);
    assert.match(JSON.stringify(schema), /prepareStartSince/);
  } finally {
    await app.close();
  }
});

test("mutation service cannot sign, broadcast, or build before deployment registration", () => {
  const service = new DaoHarvestMutationService();
  assert.throws(() => service.build("setup", {}), /not deployed/);
  assert.deepEqual(DAO_HARVEST_READ_STATES, [
    "deposited",
    "withdrawing",
    "claim_ready",
    "completed",
    "recovery_required",
  ]);
});
