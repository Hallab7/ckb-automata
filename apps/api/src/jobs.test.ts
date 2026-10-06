import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createApiApplication } from "./bootstrap.ts";
import { JOB_TEMPLATE_CATALOG, JobReadService } from "./jobs.ts";

const GENESIS_HASH = `0x${"5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3"}`;
const jobFixture = JSON.parse(
  await readFile(new URL("../../../contracts/fixtures/job_data_v1.json", import.meta.url), "utf8"),
) as Readonly<Record<string, string>>;
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
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

function readDatabase(checkpoint: { blockNumber: string; blockHash: string } | undefined) {
  const conditions: SQL[] = [];
  let queryCount = 0;
  const transaction = {
    select: (selection?: Readonly<Record<string, unknown>>) => {
      queryCount += 1;
      const current = queryCount;
      const builder = {
        from: () => builder,
        where: (condition: SQL) => {
          conditions.push(condition);
          return builder;
        },
        orderBy: () => builder,
        limit: async () => {
          if (current === 1 && checkpoint !== undefined) return [checkpoint];
          if (selection?.["totalItems"] !== undefined) return [{ totalItems: 0 }];
          return [];
        },
      };
      return builder;
    },
  };
  return {
    conditions,
    database: {
      transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) =>
        operation(transaction),
    },
    queryCount: () => queryCount,
  };
}

function summaryDatabase() {
  const transactionQueryCounts: number[] = [];
  const row = {
    networkId: "ckb_testnet",
    jobId: jobFixture["job_id"]!,
    outpointTxHash: `0x${"12".repeat(32)}`,
    outpointIndex: "0",
    sequence: jobFixture["sequence"]!,
    ownerLockHash: jobFixture["cancel_lock_hash"]!,
    policyScriptHash: jobFixture["policy_script_hash"]!,
    policyKind: "recurring",
    state: "live",
    capacity: "10000000000",
    data: Buffer.from(jobFixture["expected_hex"]!.slice(2), "hex"),
    blockNumber: "100",
    blockHash: `0x${"34".repeat(32)}`,
    transactionIndex: "0",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const database = {
    transaction: async <T>(operation: (tx: unknown) => Promise<T>) => {
      let queryCount = 0;
      const tx = {
        select: (selection?: Readonly<Record<string, unknown>>) => {
          queryCount += 1;
          const current = queryCount;
          const result =
            current === 1
              ? [{ blockNumber: "100", blockHash: `0x${"34".repeat(32)}` }]
              : selection?.["totalItems"] !== undefined
                ? [{ totalItems: 1 }]
                : [row];
          const builder = Promise.resolve(result) as Promise<typeof result> & {
            from(): typeof builder;
            where(): typeof builder;
            orderBy(): typeof builder;
            limit(): Promise<typeof result>;
          };
          builder.from = () => builder;
          builder.where = () => builder;
          builder.orderBy = () => builder;
          builder.limit = async () => result;
          return builder;
        },
      };
      const result = await operation(tx);
      transactionQueryCounts.push(queryCount);
      return result;
    },
  };
  return { database, transactionQueryCounts };
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

test("confirmed reconciliation rows remain readable ahead of the canonical checkpoint", async () => {
  const dialect = new PgDialect();
  const stale = readDatabase({ blockNumber: "100", blockHash: `0x${"11".repeat(32)}` });
  const service = new JobReadService(stale.database as never, "ckb_testnet");

  await service.list({ limit: 20 });
  assert.equal(stale.queryCount(), 3);
  assert.equal(
    dialect.sqlToQuery(stale.conditions[1]!).sql,
    '("jobs"."network_id" = $1 and "jobs"."policy_kind" in ($2, $3))',
  );
  assert.equal(
    dialect.sqlToQuery(stale.conditions[2]!).sql,
    '("jobs"."network_id" = $1 and "jobs"."policy_kind" in ($2, $3))',
  );

  const empty = readDatabase(undefined);
  await new JobReadService(empty.database as never, "ckb_testnet").list({ limit: 20 });
  assert.equal(empty.queryCount(), 3);
});

test("payment reads exclude DAO harvest rows handled by the dedicated API", async () => {
  const dialect = new PgDialect();
  const source = readDatabase({ blockNumber: "100", blockHash: `0x${"11".repeat(32)}` });
  const service = new JobReadService(source.database as never, "ckb_testnet");

  await assert.rejects(() => service.detail(`0x${"22".repeat(32)}`), /Not Found/);
  assert.equal(
    dialect.sqlToQuery(source.conditions[1]!).sql,
    '("jobs"."network_id" = $1 and "jobs"."job_id" = $2 and "jobs"."policy_kind" in ($3, $4))',
  );
});

test("compact job lists skip chain-derived recipient totals", async () => {
  let termsCalls = 0;
  const source = summaryDatabase();
  const service = new JobReadService(source.database as never, "ckb_testnet", {
    pending: { list: async () => [] },
    quotes: {
      terms: async (jobId) => {
        termsCalls += 1;
        return {
          jobId,
          network: "ckb_testnet",
          template: "recurring",
          payout: { perExecution: "100", total: "300" },
          schedule: { totalExecutions: "3" },
          source: {
            payloadHash: jobFixture["payload_hash"]!,
            outPoint: { txHash: `0x${"12".repeat(32)}`, index: "0" },
          },
        };
      },
    },
  });

  const compact = await service.list({ limit: 12, summary: "compact" });
  assert.equal(compact.items.length, 1);
  assert.equal(compact.summary.totalItems, 1);
  assert.equal(compact.summary.recipientTotal, null);
  assert.equal(termsCalls, 0);
  assert.equal(source.transactionQueryCounts[0], 4);

  const full = await service.list({ limit: 1, summary: "full" });
  assert.equal(full.summary.recipientTotal, "300");
  assert.deepEqual(full.summary.nextRecipientAmount, { perExecution: "100", total: "300" });
  assert.equal(termsCalls, 1);
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
      "/v1/transactions/register-creation",
    ]) {
      assert.ok(document.paths[path], `missing OpenAPI path ${path}`);
    }

    const listOperation = document.paths["/v1/jobs"]?.get;
    assert.ok(listOperation);
    const parameters = (listOperation.parameters ?? []).map((parameter) =>
      "$ref" in parameter ? parameter.$ref : parameter.name,
    );
    assert.deepEqual(parameters.toSorted(), ["cursor", "limit", "state", "summary", "template"]);
    const listResponse = listOperation.responses?.["200"];
    assert.ok(listResponse && "content" in listResponse);
    const listSchema = listResponse.content?.["application/json"]?.schema;
    assert.ok(listSchema && !("$ref" in listSchema));
    const page = listSchema.properties?.["page"];
    assert.ok(page && !("$ref" in page));
    const totalItems = page.properties?.["totalItems"];
    assert.ok(totalItems && !("$ref" in totalItems));
    assert.equal(totalItems.type, "integer");

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
    const invalidSummary = await fastify.inject({
      method: "GET",
      url: "/v1/jobs?summary=approximate",
    });
    assert.equal(invalidSummary.statusCode, 400);
    assert.equal((invalidSummary.json() as { code: string }).code, "INVALID_JOB_QUERY");
    const invalidOwner = await fastify.inject({ method: "GET", url: "/v1/accounts/nope/jobs" });
    assert.equal(invalidOwner.statusCode, 400);
    assert.equal((invalidOwner.json() as { code: string }).code, "INVALID_HASH");
  } finally {
    await result.app.close();
  }
});
