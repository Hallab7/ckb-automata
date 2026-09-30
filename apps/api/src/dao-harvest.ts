import { createHash } from "node:crypto";

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { and, desc, eq, getTableColumns, lt, or } from "drizzle-orm";

import type { UnsignedDeadlineTransaction } from "@ckb-automata/core";

import type { AutomataDatabase } from "./database/client.ts";
import { daoHarvestJobs, jobs } from "./database/schema.ts";

const HASH = /^0x[0-9a-f]{64}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const DAO_HARVEST_READ_STATES = [
  "deposited",
  "withdrawing",
  "claim_ready",
  "completed",
  "recovery_required",
] as const;
export type DaoHarvestReadState = (typeof DAO_HARVEST_READ_STATES)[number];

export interface DaoHarvestReadModel {
  readonly jobId: string;
  readonly ownerLockHash: string;
  readonly state: DaoHarvestReadState;
  readonly vaultOutPoint: { readonly txHash: string; readonly index: string };
  readonly schedule: {
    readonly depositEpochSince: string;
    readonly prepareStartSince: string;
    readonly prepareCutoffSince: string;
    readonly claimMaturitySince: string | null;
  };
  readonly progress: { readonly completedCycles: string; readonly totalCycles: string };
  readonly principal: string;
  readonly payoutLockHash: string;
  readonly economics: unknown;
  readonly source: {
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly canonical: boolean;
  };
  readonly updatedAt: string;
}

export interface DaoHarvestListResponse {
  readonly items: readonly DaoHarvestReadModel[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
}

export interface DaoHarvestQuoteReadModel {
  readonly quoteId: string;
  readonly jobId: string;
  readonly state: DaoHarvestReadState;
  readonly economics: unknown;
  readonly chainSnapshot: { readonly blockNumber: string; readonly blockHash: string };
  readonly expiry: { readonly condition: "canonical_harvest_snapshot"; readonly blockHash: string };
}

export interface DaoHarvestUnsignedBuild {
  readonly operation: "setup" | "stop" | "exit" | "recover";
  readonly transaction: UnsignedDeadlineTransaction;
  readonly signingEntries: readonly unknown[];
  readonly intent: unknown;
  readonly policyCriticalHash: string;
}

export interface DaoHarvestMutationAdapter {
  build(
    operation: DaoHarvestUnsignedBuild["operation"],
    body: unknown,
  ): Promise<DaoHarvestUnsignedBuild>;
}

type Row = typeof daoHarvestJobs.$inferSelect & { readonly ownerLockHash: string };

function hash(value: string, name: string): string {
  if (!HASH.test(value)) throw new BadRequestException(`${name} must be a lowercase 32-byte hash`);
  return value;
}

function limit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (Array.isArray(value) || typeof value === "object" || value === null) {
    throw new BadRequestException("limit must be provided once");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

function cursor(value: unknown): { readonly block: string; readonly jobId: string } | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 256)
    throw new BadRequestException("cursor is invalid");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate["block"] !== "string" || typeof candidate["jobId"] !== "string")
      throw new Error();
    if (!/^(0|[1-9][0-9]*)$/.test(candidate["block"]) || !HASH.test(candidate["jobId"]))
      throw new Error();
    return { block: candidate["block"], jobId: candidate["jobId"] };
  } catch {
    throw new BadRequestException("cursor is invalid");
  }
}

function encodeCursor(row: Row): string {
  return Buffer.from(
    JSON.stringify({ block: row.observedBlockNumber, jobId: row.jobId }),
    "utf8",
  ).toString("base64url");
}

function readModel(row: Row): DaoHarvestReadModel {
  return Object.freeze({
    jobId: row.jobId,
    ownerLockHash: row.ownerLockHash,
    state: row.vaultState as DaoHarvestReadState,
    vaultOutPoint: Object.freeze({
      txHash: row.vaultOutpointTxHash,
      index: row.vaultOutpointIndex,
    }),
    schedule: Object.freeze({
      depositEpochSince: row.depositEpochSince,
      prepareStartSince: row.prepareStartSince,
      prepareCutoffSince: row.prepareCutoffSince,
      claimMaturitySince: row.claimMaturitySince,
    }),
    progress: Object.freeze({
      completedCycles: row.completedCycles,
      totalCycles: row.totalCycles,
    }),
    principal: row.principalCapacity,
    payoutLockHash: row.payoutLockHash,
    economics: row.economicsSnapshot,
    source: Object.freeze({
      blockNumber: row.observedBlockNumber,
      blockHash: row.observedBlockHash,
      canonical: row.canonical,
    }),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export class DaoHarvestReadService {
  readonly #database: AutomataDatabase;
  readonly #network: string;

  constructor(database: AutomataDatabase, network: string) {
    this.#database = database;
    this.#network = network;
  }

  async list(query: {
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<DaoHarvestListResponse> {
    const pageLimit = limit(query.limit);
    const pageCursor = cursor(query.cursor);
    const conditions = [eq(daoHarvestJobs.networkId, this.#network)];
    if (pageCursor) {
      conditions.push(
        or(
          lt(daoHarvestJobs.observedBlockNumber, pageCursor.block),
          and(
            eq(daoHarvestJobs.observedBlockNumber, pageCursor.block),
            lt(daoHarvestJobs.jobId, pageCursor.jobId),
          ),
        )!,
      );
    }
    const rows = await this.#database
      .select({ ...getTableColumns(daoHarvestJobs), ownerLockHash: jobs.ownerLockHash })
      .from(daoHarvestJobs)
      .innerJoin(
        jobs,
        and(eq(jobs.networkId, daoHarvestJobs.networkId), eq(jobs.jobId, daoHarvestJobs.jobId)),
      )
      .where(and(...conditions))
      .orderBy(desc(daoHarvestJobs.observedBlockNumber), desc(daoHarvestJobs.jobId))
      .limit(pageLimit + 1);
    const hasMore = rows.length > pageLimit;
    const selected = rows.slice(0, pageLimit) as Row[];
    return Object.freeze({
      items: Object.freeze(selected.map(readModel)),
      page: Object.freeze({
        limit: pageLimit,
        nextCursor: hasMore && selected.at(-1) ? encodeCursor(selected.at(-1)!) : null,
      }),
    });
  }

  async detail(jobIdInput: string): Promise<DaoHarvestReadModel> {
    const jobId = hash(jobIdInput, "jobId");
    const [row] = await this.#database
      .select({ ...getTableColumns(daoHarvestJobs), ownerLockHash: jobs.ownerLockHash })
      .from(daoHarvestJobs)
      .innerJoin(
        jobs,
        and(eq(jobs.networkId, daoHarvestJobs.networkId), eq(jobs.jobId, daoHarvestJobs.jobId)),
      )
      .where(and(eq(daoHarvestJobs.networkId, this.#network), eq(daoHarvestJobs.jobId, jobId)))
      .limit(1);
    if (!row) throw new NotFoundException("DAO harvest automation was not found");
    return readModel(row as Row);
  }

  async quote(jobId: string): Promise<DaoHarvestQuoteReadModel> {
    const item = await this.detail(jobId);
    const body = {
      jobId: item.jobId,
      state: item.state,
      economics: item.economics,
      chainSnapshot: item.source,
    };
    return Object.freeze({
      quoteId: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      jobId: item.jobId,
      state: item.state,
      economics: item.economics,
      chainSnapshot: Object.freeze({
        blockNumber: item.source.blockNumber,
        blockHash: item.source.blockHash,
      }),
      expiry: Object.freeze({
        condition: "canonical_harvest_snapshot" as const,
        blockHash: item.source.blockHash,
      }),
    });
  }
}

export class DaoHarvestMutationService {
  readonly #adapter: DaoHarvestMutationAdapter | undefined;

  constructor(adapter?: DaoHarvestMutationAdapter) {
    this.#adapter = adapter;
  }

  build(
    operation: DaoHarvestUnsignedBuild["operation"],
    body: unknown,
  ): Promise<DaoHarvestUnsignedBuild> {
    if (!this.#adapter) {
      throw new ServiceUnavailableException("DAO harvest transaction building is not deployed");
    }
    return this.#adapter.build(operation, body);
  }
}

export class DaoHarvestController {
  readonly #reads: DaoHarvestReadService;
  readonly #mutations: DaoHarvestMutationService;

  constructor(reads: DaoHarvestReadService, mutations: DaoHarvestMutationService) {
    this.#reads = reads;
    this.#mutations = mutations;
  }

  list(query: {
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<DaoHarvestListResponse> {
    return this.#reads.list(query);
  }
  detail(jobId: string): Promise<DaoHarvestReadModel> {
    return this.#reads.detail(jobId);
  }
  quote(jobId: string): Promise<DaoHarvestQuoteReadModel> {
    return this.#reads.quote(jobId);
  }
  setup(body: unknown): Promise<DaoHarvestUnsignedBuild> {
    return this.#mutations.build("setup", body);
  }
  stop(body: unknown): Promise<DaoHarvestUnsignedBuild> {
    return this.#mutations.build("stop", body);
  }
  exit(body: unknown): Promise<DaoHarvestUnsignedBuild> {
    return this.#mutations.build("exit", body);
  }
  recover(body: unknown): Promise<DaoHarvestUnsignedBuild> {
    return this.#mutations.build("recover", body);
  }
}

const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const decimalSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const harvestSchema = {
  type: "object",
  required: [
    "jobId",
    "ownerLockHash",
    "state",
    "vaultOutPoint",
    "schedule",
    "progress",
    "principal",
    "payoutLockHash",
    "economics",
    "source",
    "updatedAt",
  ],
  properties: {
    jobId: hashSchema,
    ownerLockHash: hashSchema,
    state: { type: "string", enum: [...DAO_HARVEST_READ_STATES] },
    vaultOutPoint: { type: "object" },
    schedule: {
      type: "object",
      required: [
        "depositEpochSince",
        "prepareStartSince",
        "prepareCutoffSince",
        "claimMaturitySince",
      ],
      properties: {
        depositEpochSince: decimalSchema,
        prepareStartSince: decimalSchema,
        prepareCutoffSince: decimalSchema,
        claimMaturitySince: { ...decimalSchema, nullable: true },
      },
    },
    progress: {
      type: "object",
      required: ["completedCycles", "totalCycles"],
      properties: { completedCycles: decimalSchema, totalCycles: decimalSchema },
    },
    principal: decimalSchema,
    payoutLockHash: hashSchema,
    economics: { type: "object" },
    source: { type: "object" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

Injectable()(DaoHarvestReadService);
Injectable()(DaoHarvestMutationService);
Inject(DaoHarvestReadService)(DaoHarvestController, undefined, 0);
Inject(DaoHarvestMutationService)(DaoHarvestController, undefined, 1);
Controller("dao-harvest")(DaoHarvestController);
ApiTags("DAO harvest")(DaoHarvestController);

for (const [method, path, summary] of [
  ["setup", "setup", "Build an unsigned DAO harvest setup transaction"],
  ["stop", "stop", "Build an unsigned stop-recurrence transaction"],
  ["exit", "exit", "Build an unsigned owner exit transaction"],
  ["recover", "recover", "Build an unsigned owner recovery transaction"],
] as const) {
  Post(path)(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  Body()(DaoHarvestController.prototype, method, 0);
  ApiOperation({ summary })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiBody({ schema: { type: "object" } })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiOkResponse({ description: "Unsigned transaction and review intent" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiBadRequestResponse({ description: "Malformed or stale request" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiServiceUnavailableResponse({ description: "Harvest deployment or chain read unavailable" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
}

Get()(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);
Query()(DaoHarvestController.prototype, "list", 0);
ApiOperation({ summary: "List indexed DAO harvest automations" })(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);
ApiQuery({ name: "cursor", required: false, type: String })(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);
ApiQuery({ name: "limit", required: false, type: Number })(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    properties: { items: { type: "array", items: harvestSchema }, page: { type: "object" } },
  },
})(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);

for (const [method, suffix, summary, schema] of [
  ["detail", ":jobId", "Read one DAO harvest automation", harvestSchema],
  ["quote", ":jobId/quote", "Read a canonical DAO harvest economics quote", { type: "object" }],
] as const) {
  Get(suffix)(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  Param("jobId")(DaoHarvestController.prototype, method, 0);
  ApiOperation({ summary })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiParam({ name: "jobId", schema: hashSchema })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiOkResponse({ schema })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiBadRequestResponse({ description: "Malformed job ID" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiNotFoundResponse({ description: "DAO harvest automation not found" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
}
