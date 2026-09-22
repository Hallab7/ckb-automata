import { createHash } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
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
import { and, desc, eq, lt, lte, or, type SQL } from "drizzle-orm";

import { inspectJobData } from "@ckb-automata/core";

import type { AutomataDatabase } from "./database/client.ts";
import { indexerCheckpoints, jobs } from "./database/schema.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const CURSOR_VERSION = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const UINT32_MAX = 4_294_967_295n;
const UINT64_MAX = 18_446_744_073_709_551_615n;

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
  readonly page: {
    readonly limit: number;
    readonly nextCursor: string | null;
  };
  readonly indexCheckpoint: JobSourceProvenance["indexCheckpoint"];
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
  readonly c: string | null;
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
      (Reflect.get(decoded, "c") !== null && typeof Reflect.get(decoded, "c") !== "string") ||
      !["b", "t", "o"].every((key) => /^[0-9]+$/.test(String(Reflect.get(decoded, key)))) ||
      !HASH_PATTERN.test(String(Reflect.get(decoded, "j")))
    ) {
      throw new Error("invalid cursor payload");
    }
    const payload = decoded as CursorPayload;
    if (
      BigInt(payload.b) > UINT64_MAX ||
      BigInt(payload.t) > UINT32_MAX ||
      BigInt(payload.o) > UINT32_MAX ||
      (payload.c !== null && !/^(0|[1-9][0-9]*):0x[0-9a-f]{64}$/.test(payload.c))
    ) {
      throw new Error("cursor value is outside its canonical range");
    }
    if (payload.c !== null && BigInt(payload.c.slice(0, payload.c.indexOf(":"))) > UINT64_MAX) {
      throw new Error("cursor checkpoint is outside its canonical range");
    }
    return payload;
  } catch {
    throw invalidQuery("cursor is malformed");
  }
}

function bytesToHex(value: Buffer): string {
  return `0x${value.toString("hex")}`;
}

function checkpointKey(checkpoint: Checkpoint): string | null {
  return checkpoint === null ? null : `${checkpoint.blockNumber}:${checkpoint.blockHash}`;
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

  constructor(database: AutomataDatabase, network: string) {
    this.#database = database;
    this.#network = network;
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
        const [row] =
          checkpointRow === undefined
            ? []
            : await tx
                .select()
                .from(jobs)
                .where(
                  and(
                    eq(jobs.networkId, this.#network),
                    eq(jobs.jobId, jobId),
                    lte(jobs.blockNumber, checkpointRow.blockNumber),
                  ),
                )
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
        if (cursor !== undefined && cursor.c !== checkpointKey(checkpoint)) {
          throw new ConflictException({
            status: "conflict",
            code: "STALE_JOB_CURSOR",
            message: "the index checkpoint changed; restart pagination",
          });
        }

        if (checkpoint === null) return { checkpoint, rows: [] as JobRow[] };

        const clauses: SQL[] = [
          eq(jobs.networkId, this.#network),
          lte(jobs.blockNumber, checkpoint.blockNumber),
        ];
        if (ownerLockHash !== undefined) clauses.push(eq(jobs.ownerLockHash, ownerLockHash));
        if (query.state !== undefined) clauses.push(eq(jobs.state, query.state));
        if (query.template !== undefined) clauses.push(eq(jobs.policyKind, query.template));
        if (cursor !== undefined) clauses.push(cursorCondition(cursor));

        const rows = await tx
          .select()
          .from(jobs)
          .where(and(...clauses))
          .orderBy(
            desc(jobs.blockNumber),
            desc(jobs.transactionIndex),
            desc(jobs.outpointIndex),
            desc(jobs.jobId),
          )
          .limit(query.limit + 1);
        return { checkpoint, rows };
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
            c: checkpointKey(result.checkpoint),
            b: last.blockNumber,
            t: last.transactionIndex,
            o: last.outpointIndex,
            j: last.jobId,
          })
        : null;

    return Object.freeze({
      items: Object.freeze(pageRows.map((row) => readModel(row, result.checkpoint))),
      page: Object.freeze({ limit: query.limit, nextCursor }),
      indexCheckpoint: result.checkpoint,
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
  required: ["items", "page", "indexCheckpoint"],
  properties: {
    items: { type: "array", items: jobSchema },
    page: {
      type: "object",
      required: ["limit", "nextCursor"],
      properties: { limit: { type: "integer" }, nextCursor: { type: "string", nullable: true } },
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
