import { createHash } from "node:crypto";

import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { and, count, desc, eq, lt, or, type SQL } from "drizzle-orm";

import { inspectJobData } from "@ckb-automata/core";

import type { AutomataDatabase } from "./database/client.ts";
import { indexerCheckpoints, jobs } from "./database/schema.ts";
import type { PendingCreationReadModel, PendingCreationService } from "./pending-creations.ts";
import type { JobQuoteService, JobTerms } from "./quotes.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const CURSOR_VERSION = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const UINT32_MAX = 4_294_967_295n;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const SUMMARY_TERMS_CONCURRENCY = 4;
const TERMS_CACHE_LIMIT = 500;

export const JOB_STATES = ["live", "spent", "orphaned"] as const;
export const JOB_TEMPLATES = ["deadline", "recurring"] as const;

export type JobState = (typeof JOB_STATES)[number];
export type JobTemplateId = (typeof JOB_TEMPLATES)[number];

export interface JobListQuery {
  readonly cursor?: string;
  readonly limit?: string | number;
  readonly state?: string;
  readonly template?: string;
}

export interface JobSourceProvenance {
  readonly canonical: boolean;
  readonly outPoint: { readonly txHash: string; readonly index: string };
  readonly block: {
    readonly number: string;
    readonly hash: string;
    readonly transactionIndex: string;
  };
  readonly indexCheckpoint: {
    readonly blockNumber: string;
    readonly blockHash: string;
  } | null;
}

export interface JobReadModel {
  readonly jobId: string;
  readonly network: string;
  readonly template: JobTemplateId;
  readonly state: JobState;
  readonly sequence: string;
  readonly ownerLockHash: string;
  readonly policyScriptHash: string;
  readonly payloadHash: string;
  readonly trigger: {
    readonly kind: number;
    readonly metric: string;
    readonly paramsHash: string;
    readonly notBefore: string;
    readonly notAfter: string;
  };
  readonly funds: {
    readonly capacity: string;
    readonly executorReward: string;
    readonly remainingBudget: string;
  };
  readonly remainingRuns: string;
  readonly cancellationLockHash: string;
  readonly protocol: {
    readonly version: number;
    readonly flags: number;
    readonly rawData: string;
  };
  readonly source: JobSourceProvenance;
  readonly updatedAt: string;
}

export interface JobListResponse {
  readonly items: readonly JobReadModel[];
  readonly pendingItems: readonly PendingCreationReadModel[];
  readonly page: {
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly totalItems: number;
  };
  readonly summary: JobListSummary;
  readonly indexCheckpoint: JobSourceProvenance["indexCheckpoint"];
}

export interface JobListSummary {
  readonly nextJob: JobReadModel | null;
  readonly nextRecipientAmount: JobTerms["payout"] | null;
  readonly recipientTotal: string | null;
  readonly states: {
    readonly confirming: number;
    readonly live: number;
    readonly orphaned: number;
    readonly spent: number;
    readonly submitting: number;
  };
  readonly totalItems: number;
}

export interface JobTemplate {
  readonly id: JobTemplateId;
  readonly version: 1;
  readonly name: string;
  readonly description: string;
  readonly execution: "terminal" | "recurring";
  readonly triggerMetric: "block";
}

export const JOB_TEMPLATE_CATALOG: readonly JobTemplate[] = Object.freeze([
  Object.freeze({
    id: "deadline",
    version: 1,
    name: "Deadline finalization",
    description: "Finalize a committed campaign outcome at or after its block deadline.",
    execution: "terminal",
    triggerMetric: "block",
  }),
  Object.freeze({
    id: "recurring",
    version: 1,
    name: "Recurring distribution",
    description: "Pay a fixed recipient on a block interval until the committed run count ends.",
    execution: "recurring",
    triggerMetric: "block",
  }),
]);

interface ParsedListQuery {
  readonly cursor?: string;
  readonly limit: number;
  readonly state?: JobState;
  readonly template?: JobTemplateId;
}

interface CursorPayload {
  readonly v: 1;
  readonly f: string;
  readonly b: string;
  readonly t: string;
  readonly o: string;
  readonly j: string;
}

type JobRow = typeof jobs.$inferSelect;
type Checkpoint = JobSourceProvenance["indexCheckpoint"];

function one(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || typeof value === "object" || value === null) {
    throw invalidQuery(`${name} must be provided once`);
  }
  return String(value);
}

function invalidQuery(message: string): BadRequestException {
  return new BadRequestException({ status: "invalid_request", code: "INVALID_JOB_QUERY", message });
}

function parseListQuery(input: Readonly<Record<string, unknown>>): ParsedListQuery {
  const allowed = new Set(["cursor", "limit", "state", "template"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw invalidQuery(`unsupported query parameter: ${unknown[0]}`);

  const cursor = one(input["cursor"], "cursor");
  const rawLimit = one(input["limit"], "limit");
  const limit = rawLimit === undefined ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  if (!/^[1-9][0-9]*$/.test(rawLimit ?? String(DEFAULT_PAGE_SIZE)) || limit > MAX_PAGE_SIZE) {
    throw invalidQuery(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }

  const state = one(input["state"], "state");
  if (state !== undefined && !(JOB_STATES as readonly string[]).includes(state)) {
    throw invalidQuery(`state must be one of: ${JOB_STATES.join(", ")}`);
  }
  const template = one(input["template"], "template");
  if (template !== undefined && !(JOB_TEMPLATES as readonly string[]).includes(template)) {
    throw invalidQuery(`template must be one of: ${JOB_TEMPLATES.join(", ")}`);
  }

  return {
    ...(cursor === undefined ? {} : { cursor }),
    limit,
    ...(state === undefined ? {} : { state: state as JobState }),
    ...(template === undefined ? {} : { template: template as JobTemplateId }),
  };
}

function parseHash(value: string, name: string): string {
  if (!HASH_PATTERN.test(value)) {
    throw new BadRequestException({
      status: "invalid_request",
      code: "INVALID_HASH",
      message: `${name} must be a lowercase 0x-prefixed 32-byte hash`,
    });
  }
  return value;
}

function filterFingerprint(
  network: string,
  ownerLockHash: string | undefined,
  query: ParsedListQuery,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        network,
        ownerLockHash: ownerLockHash ?? null,
        state: query.state ?? null,
        template: query.template ?? null,
      }),
    )
    .digest("base64url");
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded) ||
      Reflect.get(decoded, "v") !== CURSOR_VERSION ||
      typeof Reflect.get(decoded, "f") !== "string" ||
      !["b", "t", "o"].every((key) => /^[0-9]+$/.test(String(Reflect.get(decoded, key)))) ||
      !HASH_PATTERN.test(String(Reflect.get(decoded, "j")))
    ) {
      throw new Error("invalid cursor payload");
    }
    const payload = decoded as CursorPayload;
    if (
      BigInt(payload.b) > UINT64_MAX ||
      BigInt(payload.t) > UINT32_MAX ||
      BigInt(payload.o) > UINT32_MAX
    ) {
      throw new Error("cursor value is outside its canonical range");
    }
    return Object.freeze({
      v: CURSOR_VERSION,
      f: payload.f,
      b: payload.b,
      t: payload.t,
      o: payload.o,
      j: payload.j,
    });
  } catch {
    throw invalidQuery("cursor is malformed");
  }
}

function bytesToHex(value: Buffer): string {
  return `0x${value.toString("hex")}`;
}

function readModel(row: JobRow, checkpoint: Checkpoint): JobReadModel {
  if (!(JOB_TEMPLATES as readonly string[]).includes(row.policyKind)) {
    throw new Error(`indexed job ${row.jobId} has an unsupported policy kind`);
  }
  const inspection = inspectJobData(row.data);
  if (inspection.status !== "ok") throw new Error(`indexed job ${row.jobId} is not decodable`);
  const job = inspection.job;
  if (
    job.jobId !== row.jobId ||
    job.sequence.toString() !== row.sequence ||
    job.policyScriptHash !== row.policyScriptHash ||
    job.cancelLockHash !== row.ownerLockHash
  ) {
    throw new Error(`indexed job ${row.jobId} does not match its canonical data`);
  }

  return Object.freeze({
    jobId: row.jobId,
    network: row.networkId,
    template: row.policyKind as JobTemplateId,
    state: row.state as JobState,
    sequence: row.sequence,
    ownerLockHash: row.ownerLockHash,
    policyScriptHash: row.policyScriptHash,
    payloadHash: job.payloadHash,
    trigger: Object.freeze({
      kind: job.trigger.kind,
      metric: job.trigger.metric,
      paramsHash: job.trigger.paramsHash,
      notBefore: job.notBefore.toString(),
      notAfter: job.notAfter.toString(),
    }),
    funds: Object.freeze({
      capacity: row.capacity,
      executorReward: job.reward.toString(),
      remainingBudget: job.remainingBudget.toString(),
    }),
    remainingRuns: job.remainingRuns.toString(),
    cancellationLockHash: job.cancelLockHash,
    protocol: Object.freeze({
      version: job.version,
      flags: job.flags,
      rawData: bytesToHex(row.data),
    }),
    source: Object.freeze({
      canonical: row.state !== "orphaned",
      outPoint: Object.freeze({ txHash: row.outpointTxHash, index: row.outpointIndex }),
      block: Object.freeze({
        number: row.blockNumber,
        hash: row.blockHash,
        transactionIndex: row.transactionIndex,
      }),
      indexCheckpoint: checkpoint,
    }),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function cursorCondition(cursor: CursorPayload): SQL {
  return or(
    lt(jobs.blockNumber, cursor.b),
    and(eq(jobs.blockNumber, cursor.b), lt(jobs.transactionIndex, cursor.t)),
    and(
      eq(jobs.blockNumber, cursor.b),
      eq(jobs.transactionIndex, cursor.t),
      lt(jobs.outpointIndex, cursor.o),
    ),
    and(
      eq(jobs.blockNumber, cursor.b),
      eq(jobs.transactionIndex, cursor.t),
      eq(jobs.outpointIndex, cursor.o),
      lt(jobs.jobId, cursor.j),
    ),
  )!;
}

export class JobReadService {
  readonly #database: AutomataDatabase;
  readonly #network: string;
  readonly #pending: Pick<PendingCreationService, "list"> | undefined;
  readonly #quotes: Pick<JobQuoteService, "terms"> | undefined;
  readonly #termsCache = new Map<string, Promise<JobTerms>>();

  constructor(
    database: AutomataDatabase,
    network: string,
    dependencies: {
      readonly pending?: Pick<PendingCreationService, "list">;
      readonly quotes?: Pick<JobQuoteService, "terms">;
    } = {},
  ) {
    this.#database = database;
    this.#network = network;
    this.#pending = dependencies.pending;
    this.#quotes = dependencies.quotes;
  }

  templates(): readonly JobTemplate[] {
    return JOB_TEMPLATE_CATALOG;
  }

  async detail(jobIdInput: string): Promise<JobReadModel> {
    const jobId = parseHash(jobIdInput, "jobId");
    const result = await this.#database.transaction(
      async (tx) => {
        const [checkpointRow] = await tx
          .select({
            blockNumber: indexerCheckpoints.blockNumber,
            blockHash: indexerCheckpoints.blockHash,
          })
          .from(indexerCheckpoints)
          .where(eq(indexerCheckpoints.networkId, this.#network))
          .limit(1);
        const [row] = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.networkId, this.#network), eq(jobs.jobId, jobId)))
          .limit(1);
        return { checkpoint: checkpointRow ?? null, row };
      },
      { accessMode: "read only", isolationLevel: "repeatable read" },
    );
    if (result.row === undefined) {
      throw new NotFoundException({ status: "not_found", code: "JOB_NOT_FOUND" });
    }
    return readModel(result.row, result.checkpoint);
  }

  async list(input: Readonly<Record<string, unknown>>, owner?: string): Promise<JobListResponse> {
    const query = parseListQuery(input);
    const ownerLockHash = owner === undefined ? undefined : parseHash(owner, "lockHash");
    const fingerprint = filterFingerprint(this.#network, ownerLockHash, query);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor !== undefined && cursor.f !== fingerprint) {
      throw invalidQuery("cursor does not match the requested filters");
    }

    const result = await this.#database.transaction(
      async (tx) => {
        const [checkpointRow] = await tx
          .select({
            blockNumber: indexerCheckpoints.blockNumber,
            blockHash: indexerCheckpoints.blockHash,
          })
          .from(indexerCheckpoints)
          .where(eq(indexerCheckpoints.networkId, this.#network))
          .limit(1);
        const checkpoint = checkpointRow ?? null;
        const filters: SQL[] = [eq(jobs.networkId, this.#network)];
        if (ownerLockHash !== undefined) filters.push(eq(jobs.ownerLockHash, ownerLockHash));
        if (query.state !== undefined) filters.push(eq(jobs.state, query.state));
        if (query.template !== undefined) filters.push(eq(jobs.policyKind, query.template));
        const [total] = await tx
          .select({ totalItems: count() })
          .from(jobs)
          .where(and(...filters))
          .limit(1);
        if (total === undefined) throw new Error("job count query returned no result");

        const pageFilters = cursor === undefined ? filters : [...filters, cursorCondition(cursor)];

        const rows = await tx
          .select()
          .from(jobs)
          .where(and(...pageFilters))
          .orderBy(
            desc(jobs.blockNumber),
            desc(jobs.transactionIndex),
            desc(jobs.outpointIndex),
            desc(jobs.jobId),
          )
          .limit(query.limit + 1);
        const summaryRows =
          this.#quotes === undefined
            ? rows.slice(0, query.limit)
            : await tx
                .select()
                .from(jobs)
                .where(and(...filters));
        const allIndexedJobIds =
          this.#pending === undefined
            ? summaryRows.map((row) => ({ jobId: row.jobId }))
            : await tx
                .select({ jobId: jobs.jobId })
                .from(jobs)
                .where(eq(jobs.networkId, this.#network));
        return { allIndexedJobIds, checkpoint, rows, summaryRows, totalItems: total.totalItems };
      },
      { accessMode: "read only", isolationLevel: "repeatable read" },
    );

    const hasNext = result.rows.length > query.limit;
    const pageRows = result.rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    const nextCursor =
      hasNext && last !== undefined
        ? encodeCursor({
            v: CURSOR_VERSION,
            f: fingerprint,
            b: last.blockNumber,
            t: last.transactionIndex,
            o: last.outpointIndex,
            j: last.jobId,
          })
        : null;
    const indexedJobIds = new Set(result.allIndexedJobIds.map((row) => row.jobId));
    const pendingItems =
      this.#pending === undefined
        ? Object.freeze([])
        : await this.#pending.list({
            indexedJobIds,
            ...(ownerLockHash === undefined ? {} : { ownerLockHash }),
            ...(query.state === undefined ? {} : { state: query.state }),
            ...(query.template === undefined ? {} : { template: query.template }),
          });
    const summary = await this.#summary(result.summaryRows, pendingItems, result.checkpoint);

    return Object.freeze({
      items: Object.freeze(pageRows.map((row) => readModel(row, result.checkpoint))),
      pendingItems: query.cursor === undefined ? pendingItems : Object.freeze([]),
      page: Object.freeze({ limit: query.limit, nextCursor, totalItems: result.totalItems }),
      summary,
      indexCheckpoint: result.checkpoint,
    });
  }

  async #terms(row: JobRow): Promise<JobTerms> {
    if (this.#quotes === undefined) throw new Error("job terms reader is unavailable");
    const key = `${row.jobId}:${row.outpointTxHash}:${row.outpointIndex}`;
    const cached = this.#termsCache.get(key);
    if (cached !== undefined) return cached;
    const loading = this.#quotes.terms(row.jobId).catch((error: unknown) => {
      this.#termsCache.delete(key);
      throw error;
    });
    if (this.#termsCache.size >= TERMS_CACHE_LIMIT) {
      const oldest = this.#termsCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#termsCache.delete(oldest);
    }
    this.#termsCache.set(key, loading);
    return loading;
  }

  async #summary(
    rows: readonly JobRow[],
    pending: readonly PendingCreationReadModel[],
    checkpoint: Checkpoint,
  ): Promise<JobListSummary> {
    const states = { confirming: 0, live: 0, orphaned: 0, spent: 0, submitting: 0 };
    for (const row of rows) states[row.state as JobState] += 1;
    for (const item of pending) {
      states[
        item.status === "submitting"
          ? "submitting"
          : item.status === "waiting"
            ? "live"
            : "confirming"
      ] += 1;
    }
    const checkpointBlock = checkpoint === null ? undefined : BigInt(checkpoint.blockNumber);
    const liveRows = rows.filter((row) => row.state === "live");
    const futureRows = liveRows.filter((row) => {
      if (checkpointBlock === undefined) return true;
      const inspection = inspectJobData(row.data);
      return inspection.status === "ok" && inspection.job.notBefore > checkpointBlock;
    });
    const scheduledRows = futureRows.length > 0 ? futureRows : liveRows;
    const nextRow = scheduledRows.reduce<JobRow | undefined>((next, row) => {
      if (next === undefined) return row;
      const rowJob = inspectJobData(row.data);
      const nextJob = inspectJobData(next.data);
      if (rowJob.status !== "ok") return next;
      if (nextJob.status !== "ok") return row;
      return rowJob.job.notBefore < nextJob.job.notBefore ? row : next;
    }, undefined);
    let unavailable = false;
    let recipientTotal = pending.reduce(
      (total, item) => total + BigInt(item.recipientAmount.total),
      0n,
    );
    let nextRecipientAmount: JobTerms["payout"] | null = null;
    const canonicalRows = rows.filter((row) => row.state !== "orphaned");
    const terms: Array<{ readonly row: JobRow; readonly value: JobTerms | undefined }> = [];
    for (let index = 0; index < canonicalRows.length; index += SUMMARY_TERMS_CONCURRENCY) {
      const batch = canonicalRows.slice(index, index + SUMMARY_TERMS_CONCURRENCY);
      terms.push(
        ...(await Promise.all(
          batch.map(async (row) => {
            try {
              return { row, value: await this.#terms(row) } as const;
            } catch {
              unavailable = true;
              return { row, value: undefined } as const;
            }
          }),
        )),
      );
    }
    for (const item of terms) {
      if (item.value === undefined) continue;
      recipientTotal += BigInt(item.value.payout.total);
      if (item.row.jobId === nextRow?.jobId) nextRecipientAmount = item.value.payout;
    }
    return Object.freeze({
      nextJob: nextRow === undefined ? null : readModel(nextRow, checkpoint),
      nextRecipientAmount,
      recipientTotal: unavailable ? null : recipientTotal.toString(),
      states: Object.freeze(states),
      totalItems: rows.length + pending.length,
    });
  }
}

export class JobsController {
  readonly #jobs: JobReadService;

  constructor(jobsService: JobReadService) {
    this.#jobs = jobsService;
  }

  list(query: Readonly<Record<string, unknown>>): Promise<JobListResponse> {
    return this.#jobs.list(query);
  }

  detail(jobId: string): Promise<JobReadModel> {
    return this.#jobs.detail(jobId);
  }
}

export class AccountJobsController {
  readonly #jobs: JobReadService;

  constructor(jobsService: JobReadService) {
    this.#jobs = jobsService;
  }

  list(lockHash: string, query: Readonly<Record<string, unknown>>): Promise<JobListResponse> {
    return this.#jobs.list(query, lockHash);
  }
}

export class TemplatesController {
  readonly #jobs: JobReadService;

  constructor(jobsService: JobReadService) {
    this.#jobs = jobsService;
  }

  list(): { readonly items: readonly JobTemplate[] } {
    return Object.freeze({ items: this.#jobs.templates() });
  }
}

const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const decimalSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const checkpointSchema = {
  nullable: true,
  oneOf: [
    {
      type: "object",
      required: ["blockNumber", "blockHash"],
      properties: { blockNumber: decimalSchema, blockHash: hashSchema },
    },
  ],
};
const jobSchema = {
  type: "object",
  required: [
    "jobId",
    "network",
    "template",
    "state",
    "sequence",
    "ownerLockHash",
    "policyScriptHash",
    "payloadHash",
    "trigger",
    "funds",
    "remainingRuns",
    "cancellationLockHash",
    "protocol",
    "source",
    "updatedAt",
  ],
  properties: {
    jobId: hashSchema,
    network: { type: "string" },
    template: { type: "string", enum: [...JOB_TEMPLATES] },
    state: { type: "string", enum: [...JOB_STATES] },
    sequence: decimalSchema,
    ownerLockHash: hashSchema,
    policyScriptHash: hashSchema,
    payloadHash: hashSchema,
    trigger: {
      type: "object",
      required: ["kind", "metric", "paramsHash", "notBefore", "notAfter"],
      properties: {
        kind: { type: "integer", minimum: 1, maximum: 6 },
        metric: { type: "string", enum: ["block", "epoch", "timestamp", "none"] },
        paramsHash: hashSchema,
        notBefore: decimalSchema,
        notAfter: decimalSchema,
      },
    },
    funds: {
      type: "object",
      required: ["capacity", "executorReward", "remainingBudget"],
      properties: {
        capacity: decimalSchema,
        executorReward: decimalSchema,
        remainingBudget: decimalSchema,
      },
    },
    remainingRuns: decimalSchema,
    cancellationLockHash: hashSchema,
    protocol: {
      type: "object",
      required: ["version", "flags", "rawData"],
      properties: {
        version: { type: "integer", enum: [1] },
        flags: { type: "integer", enum: [0] },
        rawData: { type: "string", pattern: "^0x(?:[0-9a-f]{2})+$" },
      },
    },
    source: {
      type: "object",
      required: ["canonical", "outPoint", "block", "indexCheckpoint"],
      properties: {
        canonical: { type: "boolean" },
        outPoint: {
          type: "object",
          required: ["txHash", "index"],
          properties: { txHash: hashSchema, index: decimalSchema },
        },
        block: {
          type: "object",
          required: ["number", "hash", "transactionIndex"],
          properties: {
            number: decimalSchema,
            hash: hashSchema,
            transactionIndex: decimalSchema,
          },
        },
        indexCheckpoint: checkpointSchema,
      },
    },
    updatedAt: { type: "string", format: "date-time" },
  },
};
const listSchema = {
  type: "object",
  required: ["items", "pendingItems", "page", "summary", "indexCheckpoint"],
  properties: {
    items: { type: "array", items: jobSchema },
    pendingItems: {
      type: "array",
      items: {
        type: "object",
        required: [
          "jobId",
          "notBefore",
          "ownerLockHash",
          "recipientAmount",
          "remainingRuns",
          "template",
          "confirmations",
          "requiredConfirmations",
          "status",
          "submittedAt",
          "transactionHash",
        ],
        properties: {
          jobId: hashSchema,
          notBefore: decimalSchema,
          ownerLockHash: hashSchema,
          recipientAmount: {
            type: "object",
            required: ["perExecution", "total"],
            properties: { perExecution: decimalSchema, total: decimalSchema },
          },
          remainingRuns: decimalSchema,
          template: { type: "string", enum: [...JOB_TEMPLATES] },
          confirmations: decimalSchema,
          requiredConfirmations: { type: "integer", minimum: 1 },
          status: { type: "string", enum: ["submitting", "confirming", "waiting"] },
          submittedAt: { type: "string", format: "date-time" },
          transactionHash: hashSchema,
        },
      },
    },
    page: {
      type: "object",
      required: ["limit", "nextCursor", "totalItems"],
      properties: {
        limit: { type: "integer" },
        nextCursor: { type: "string", nullable: true },
        totalItems: { type: "integer", minimum: 0 },
      },
    },
    summary: {
      type: "object",
      required: ["nextJob", "nextRecipientAmount", "recipientTotal", "states", "totalItems"],
      properties: {
        nextJob: { ...jobSchema, nullable: true },
        nextRecipientAmount: {
          nullable: true,
          oneOf: [
            {
              type: "object",
              required: ["perExecution", "total"],
              properties: { perExecution: decimalSchema, total: decimalSchema },
            },
          ],
        },
        recipientTotal: { ...decimalSchema, nullable: true },
        states: {
          type: "object",
          required: ["confirming", "live", "orphaned", "spent", "submitting"],
          properties: {
            confirming: { type: "integer", minimum: 0 },
            live: { type: "integer", minimum: 0 },
            orphaned: { type: "integer", minimum: 0 },
            spent: { type: "integer", minimum: 0 },
            submitting: { type: "integer", minimum: 0 },
          },
        },
        totalItems: { type: "integer", minimum: 0 },
      },
    },
    indexCheckpoint: checkpointSchema,
  },
};

function decorateList(target: object, property: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, property)!;
  ApiOperation({ summary: "List indexed jobs with stable cursor pagination" })(
    target,
    property,
    descriptor,
  );
  ApiQuery({ name: "cursor", required: false, type: String })(target, property, descriptor);
  ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    schema: { minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
  })(target, property, descriptor);
  ApiQuery({ name: "state", required: false, enum: JOB_STATES })(target, property, descriptor);
  ApiQuery({ name: "template", required: false, enum: JOB_TEMPLATES })(
    target,
    property,
    descriptor,
  );
  ApiOkResponse({ schema: listSchema })(target, property, descriptor);
  ApiBadRequestResponse({ description: "Malformed filter or cursor" })(
    target,
    property,
    descriptor,
  );
  ApiConflictResponse({ description: "Index checkpoint changed during pagination" })(
    target,
    property,
    descriptor,
  );
}

Injectable()(JobReadService);
Inject(JobReadService)(JobsController, undefined, 0);
Inject(JobReadService)(AccountJobsController, undefined, 0);
Inject(JobReadService)(TemplatesController, undefined, 0);

Controller("jobs")(JobsController);
ApiTags("jobs")(JobsController);
Get()(
  JobsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobsController.prototype, "list")!,
);
Query()(JobsController.prototype, "list", 0);
decorateList(JobsController.prototype, "list");
Get(":jobId")(
  JobsController.prototype,
  "detail",
  Object.getOwnPropertyDescriptor(JobsController.prototype, "detail")!,
);
Param("jobId")(JobsController.prototype, "detail", 0);
ApiOperation({ summary: "Read one indexed job" })(
  JobsController.prototype,
  "detail",
  Object.getOwnPropertyDescriptor(JobsController.prototype, "detail")!,
);
ApiParam({ name: "jobId", schema: hashSchema })(
  JobsController.prototype,
  "detail",
  Object.getOwnPropertyDescriptor(JobsController.prototype, "detail")!,
);
ApiOkResponse({ schema: jobSchema })(
  JobsController.prototype,
  "detail",
  Object.getOwnPropertyDescriptor(JobsController.prototype, "detail")!,
);
ApiBadRequestResponse({ description: "Malformed job ID" })(
  JobsController.prototype,
  "detail",
  Object.getOwnPropertyDescriptor(JobsController.prototype, "detail")!,
);
ApiNotFoundResponse({ description: "Job not found" })(
  JobsController.prototype,
  "detail",
  Object.getOwnPropertyDescriptor(JobsController.prototype, "detail")!,
);

Controller("accounts")(AccountJobsController);
ApiTags("jobs")(AccountJobsController);
Get(":lockHash/jobs")(
  AccountJobsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(AccountJobsController.prototype, "list")!,
);
Param("lockHash")(AccountJobsController.prototype, "list", 0);
Query()(AccountJobsController.prototype, "list", 1);
ApiParam({ name: "lockHash", schema: hashSchema })(
  AccountJobsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(AccountJobsController.prototype, "list")!,
);
decorateList(AccountJobsController.prototype, "list");

Controller("templates")(TemplatesController);
ApiTags("templates")(TemplatesController);
Get()(
  TemplatesController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(TemplatesController.prototype, "list")!,
);
ApiOperation({ summary: "List supported automation templates" })(
  TemplatesController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(TemplatesController.prototype, "list")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "version", "name", "description", "execution", "triggerMetric"],
          properties: {
            id: { type: "string", enum: [...JOB_TEMPLATES] },
            version: { type: "integer", enum: [1] },
            name: { type: "string" },
            description: { type: "string" },
            execution: { type: "string", enum: ["terminal", "recurring"] },
            triggerMetric: { type: "string", enum: ["block"] },
          },
        },
      },
    },
  },
})(
  TemplatesController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(TemplatesController.prototype, "list")!,
);
