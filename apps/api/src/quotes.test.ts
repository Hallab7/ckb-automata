import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { createApiApplication } from "./bootstrap.ts";
import { JOB_QUOTE_ASSUMPTIONS, stableJobQuoteId, type JobQuote } from "./quotes.ts";

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

function quoteBody(): Omit<JobQuote, "quoteId"> {
  return {
    jobId: `0x${"1".repeat(64)}`,
    network: "ckb_testnet",
    template: "deadline",
    amounts: {
      occupiedCapacity: {
        jobCell: "38100000000",
        applicationCell: "27300000000",
        total: "65400000000",
      },
      payout: { perExecution: "6300000000", total: "6300000000" },
      rewards: { perExecution: "6100000000", total: "6100000000" },
      remainingBudget: "6100000000",
      residualRefund: "38100000000",
      retainedTerminalCapacity: "27300000000",
      currentLockedTotal: "115900000000",
      estimatedFee: { minimum: "700", maximum: "409600" },
    },
    schedule: {
      executionsRemaining: "1",
      earliestBlock: "100",
      latestBlock: null,
      blocksUntilEligible: "0",
      approximateSecondsUntilEligible: "0",
      estimateBasis: "ckb_target_block_interval",
    },
    snapshot: {
      tip: { blockNumber: "110", blockHash: `0x${"2".repeat(64)}` },
      indexCheckpoint: { blockNumber: "109", blockHash: `0x${"3".repeat(64)}` },
      jobOutPoint: { txHash: `0x${"4".repeat(64)}`, index: "1" },
      jobDataHash: "5".repeat(64),
    },
    expiry: { afterBlock: "110", condition: "tip_or_job_snapshot_change" },
    assumptions: JOB_QUOTE_ASSUMPTIONS.deadline,
  };
}

test("quote identity ignores tip movement but binds job and amount state", () => {
  const original = quoteBody();
  const advanced = {
    ...original,
    schedule: {
      ...original.schedule,
      blocksUntilEligible: "0",
      approximateSecondsUntilEligible: "0",
    },
    snapshot: {
      ...original.snapshot,
      tip: { blockNumber: "111", blockHash: `0x${"6".repeat(64)}` },
      indexCheckpoint: { blockNumber: "111", blockHash: `0x${"6".repeat(64)}` },
    },
    expiry: { ...original.expiry, afterBlock: "111" },
  } satisfies Omit<JobQuote, "quoteId">;
  assert.equal(stableJobQuoteId(advanced), stableJobQuoteId(original));
  assert.notEqual(
    stableJobQuoteId({
      ...original,
      snapshot: { ...original.snapshot, jobDataHash: "7".repeat(64) },
    }),
    stableJobQuoteId(original),
  );
  assert.notEqual(
    stableJobQuoteId({
      ...original,
      amounts: { ...original.amounts, remainingBudget: "6100000001" },
    }),
    stableJobQuoteId(original),
  );
});

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
