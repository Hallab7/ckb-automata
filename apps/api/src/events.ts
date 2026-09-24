import { createHash } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Query,
  Sse,
  SseSignal,
  type MessageEvent,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { and, asc, desc, eq, gt, inArray, lt, lte, or, type SQL } from "drizzle-orm";
import { Observable } from "rxjs";

import type { AutomataDatabase } from "./database/client.ts";
import {
  indexerCheckpoints,
  jobEvents,
  jobs,
  networks,
  executorReceipts,
  transactionAttempts,
} from "./database/schema.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CURSOR_VERSION = 1;
const INT64_MAX = 9_223_372_036_854_775_807n;
export const EVENT_STREAM_BATCH_SIZE = 100;
export const EVENT_STREAM_HEARTBEAT_MS = 15_000;
export const EVENT_STREAM_POLL_MS = 1_000;
const EVENT_STREAM_MAX_BATCHES_PER_POLL = 5;

export const EVENT_SOURCES = ["indexed", "operational"] as const;
export const EVENT_CONFIDENCE = ["observed", "committed", "confirmed", "reorged"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];
export type EventConfidence = (typeof EVENT_CONFIDENCE)[number];

interface EventQuery {
  readonly cursor?: string;
  readonly limit: number;
  readonly source?: EventSource;
}

interface ActivityQuery extends EventQuery {
  readonly jobId?: string;
}

interface EventCursor {
  readonly v: 1;
  readonly f: string;
  readonly c: string | null;
  readonly i: string;
}

interface EventReadOptions {
  readonly afterEventId?: string;
}

export interface EventStreamOptions {
  readonly heartbeatMs?: number;
  readonly now?: () => Date;
  readonly pollMs?: number;
}

interface BlockReference {
  readonly number: string;
  readonly hash: string;
  readonly transactionHash: string;
  readonly transactionIndex: string | null;
}

interface AttemptReference {
  readonly id: string;
  readonly operation: string;
  readonly state: string;
  readonly transactionHash: string | null;
  readonly committedBlockNumber: string | null;
  readonly receipt: ReceiptReference | null;
}

interface ReceiptReference {
  readonly id: string;
  readonly executorLockHash: string;
  readonly keyId: string;
  readonly signature: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

interface ReplacementReference {
  readonly eventId: string;
  readonly eventType: string;
  readonly transactionHash: string;
  readonly block: BlockReference;
}

export interface JobEventReadModel {
  readonly eventId: string;
  readonly jobId: string;
  readonly eventType: string;
  readonly category: "lifecycle" | "execution" | "transaction" | "notification" | "operation";
  readonly source: EventSource;
  readonly confidence: EventConfidence;
  readonly block: BlockReference | null;
  readonly attempt: AttemptReference | null;
  readonly replacement: ReplacementReference | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly orphanedAt: string | null;
}

export interface JobEventTimeline {
  readonly jobId: string;
  readonly items: readonly JobEventReadModel[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
  readonly indexCheckpoint: { readonly blockNumber: string; readonly blockHash: string } | null;
}

export interface ActivityTimeline {
  readonly items: readonly JobEventReadModel[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
  readonly indexCheckpoint: { readonly blockNumber: string; readonly blockHash: string } | null;
}

type EventRow = typeof jobEvents.$inferSelect;
type AttemptRow = typeof transactionAttempts.$inferSelect;
type ReceiptRow = typeof executorReceipts.$inferSelect;
type Checkpoint = JobEventTimeline["indexCheckpoint"];

function invalid(message: string): BadRequestException {
  return new BadRequestException({
    status: "invalid_request",
    code: "INVALID_EVENT_QUERY",
    message,
  });
}

function parseHash(value: string): string {
  if (!HASH_PATTERN.test(value)) {
    throw new BadRequestException({
      status: "invalid_request",
      code: "INVALID_HASH",
      message: "jobId must be a lowercase 0x-prefixed 32-byte hash",
    });
  }
  return value;
}

function one(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || typeof value === "object" || value === null) {
    throw invalid(`${name} must be provided once`);
  }
  return String(value);
}

function parseQuery(input: Readonly<Record<string, unknown>>): EventQuery {
  const allowed = new Set(["cursor", "limit", "source"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw invalid(`unsupported query parameter: ${unknown[0]}`);
  const cursor = one(input["cursor"], "cursor");
  const rawLimit = one(input["limit"], "limit");
  const limit = rawLimit === undefined ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  if (!/^[1-9][0-9]*$/.test(rawLimit ?? String(DEFAULT_PAGE_SIZE)) || limit > MAX_PAGE_SIZE) {
    throw invalid(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  const source = one(input["source"], "source");
  if (source !== undefined && !(EVENT_SOURCES as readonly string[]).includes(source)) {
    throw invalid(`source must be one of: ${EVENT_SOURCES.join(", ")}`);
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    limit,
    ...(source === undefined ? {} : { source: source as EventSource }),
  };
}

function parseActivityQuery(input: Readonly<Record<string, unknown>>): ActivityQuery {
  const allowed = new Set(["cursor", "jobId", "limit", "source"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw invalid(`unsupported query parameter: ${unknown[0]}`);
  const jobId = one(input["jobId"], "jobId");
  const base = parseQuery(
    Object.fromEntries(Object.entries(input).filter(([key]) => key !== "jobId")),
  );
  return {
    ...base,
    ...(jobId === undefined ? {} : { jobId: parseHash(jobId) }),
  };
}

function checkpointKey(checkpoint: Checkpoint): string | null {
  return checkpoint === null ? null : `${checkpoint.blockNumber}:${checkpoint.blockHash}`;
}

function fingerprint(network: string, jobId: string, source: EventSource | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify({ network, jobId, source: source ?? null }))
    .digest("base64url");
}

function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): EventCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded) ||
      Reflect.get(decoded, "v") !== CURSOR_VERSION ||
      typeof Reflect.get(decoded, "f") !== "string" ||
      (Reflect.get(decoded, "c") !== null && typeof Reflect.get(decoded, "c") !== "string") ||
      !/^[1-9][0-9]*$/.test(String(Reflect.get(decoded, "i")))
    ) {
      throw new Error("invalid event cursor");
    }
    const cursor = decoded as EventCursor;
    if (BigInt(cursor.i) > INT64_MAX) {
      throw new Error("event cursor is outside its canonical range");
    }
    if (cursor.c !== null && !/^(0|[1-9][0-9]*):0x[0-9a-f]{64}$/.test(cursor.c)) {
      throw new Error("event cursor checkpoint is malformed");
    }
    return cursor;
  } catch {
    throw invalid("cursor is malformed");
  }
}

function parseEventId(value: string, name: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > INT64_MAX) {
    throw invalid(`${name} must be a canonical event ID`);
  }
  return value;
}

function resumeEventId(lastEventId: string | undefined, cursor: string | undefined): string {
  if (lastEventId !== undefined && cursor !== undefined && lastEventId !== cursor) {
    throw invalid("Last-Event-ID and cursor must match when both are provided");
  }
  return parseEventId(lastEventId ?? cursor ?? "0", "event cursor");
}

function category(row: EventRow): JobEventReadModel["category"] {
  if (row.source === "indexed") return "lifecycle";
  if (row.eventType.startsWith("execution_")) return "execution";
  if (row.eventType.startsWith("transaction_")) return "transaction";
  if (row.eventType.startsWith("notification_")) return "notification";
  return "operation";
}

function transactionIndex(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = Reflect.get(payload, "transactionIndex");
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? value : null;
}

function attemptId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = Reflect.get(payload, "attemptId");
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : undefined;
}

function safeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error("job event details contain an unsafe JSON number");
    }
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => safeJson(entry)));
  if (typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeJson(entry)])),
    );
  }
  throw new Error("job event details contain a non-JSON value");
}

function details(payload: unknown): Readonly<Record<string, unknown>> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("job event details must be a JSON object");
  }
  return safeJson(payload) as Readonly<Record<string, unknown>>;
}

function blockReference(row: EventRow): BlockReference | null {
  if (row.blockNumber === null && row.blockHash === null) return null;
  if (row.blockNumber === null || row.blockHash === null || row.txHash === null) {
    throw new Error(`event ${row.id.toString()} has incomplete block provenance`);
  }
  return Object.freeze({
    number: row.blockNumber,
    hash: row.blockHash,
    transactionHash: row.txHash,
    transactionIndex: transactionIndex(row.payload),
  });
}

function confidence(
  row: EventRow,
  checkpoint: Checkpoint,
  confirmationDepth: number,
): EventConfidence {
  if (row.source === "operational") return "observed";
  if (!row.canonical) return "reorged";
  if (row.blockNumber === null || checkpoint === null) return "committed";
  return BigInt(checkpoint.blockNumber) - BigInt(row.blockNumber) + 1n >= BigInt(confirmationDepth)
    ? "confirmed"
    : "committed";
}

function receiptReference(row: ReceiptRow | undefined): ReceiptReference | null {
  if (row === undefined) return null;
  return Object.freeze({
    id: row.id,
    executorLockHash: row.executorLockHash,
    keyId: row.keyId,
    signature: row.signature,
    payload: details(row.payload),
    createdAt: row.createdAt.toISOString(),
  });
}

function attemptReference(
  row: AttemptRow | undefined,
  receipt: ReceiptRow | undefined,
): AttemptReference | null {
  if (row === undefined) return null;
  return Object.freeze({
    id: row.id,
    operation: row.operation,
    state: row.state,
    transactionHash: row.txHash,
    committedBlockNumber: row.committedBlockNumber,
    receipt: receiptReference(receipt),
  });
}

function replacementReference(row: EventRow | undefined): ReplacementReference | null {
  if (row === undefined) return null;
  const block = blockReference(row);
  if (block === null || row.txHash === null) return null;
  return Object.freeze({
    eventId: row.id.toString(),
    eventType: row.eventType,
    transactionHash: row.txHash,
    block,
  });
}

export class JobEventsService {
  readonly #database: AutomataDatabase;
  readonly #network: string;

  constructor(database: AutomataDatabase, network: string) {
    this.#database = database;
    this.#network = network;
  }

  async timeline(
    jobIdInput: string,
    input: Readonly<Record<string, unknown>>,
    options: EventReadOptions = {},
  ): Promise<JobEventTimeline> {
    const jobId = parseHash(jobIdInput);
    const query = parseQuery(input);
    const filterFingerprint = fingerprint(this.#network, jobId, query.source);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor !== undefined && options.afterEventId !== undefined) {
      throw new Error("event cursor modes cannot be combined");
    }
    const afterEventId =
      options.afterEventId === undefined
        ? cursor?.i
        : parseEventId(options.afterEventId, "afterEventId");
    if (cursor !== undefined && cursor.f !== filterFingerprint) {
      throw invalid("cursor does not match the requested event filters");
    }

    const result = await this.#database.transaction(
      async (tx) => {
        const [network] = await tx
          .select({ confirmationDepth: networks.confirmationDepth })
          .from(networks)
          .where(eq(networks.id, this.#network))
          .limit(1);
        const [knownJob] = await tx
          .select({ jobId: jobs.jobId })
          .from(jobs)
          .where(and(eq(jobs.networkId, this.#network), eq(jobs.jobId, jobId)))
          .limit(1);
        if (knownJob === undefined) {
          throw new NotFoundException({ status: "not_found", code: "JOB_NOT_FOUND" });
        }
        if (network === undefined) throw new Error("configured network is not initialized");

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
            code: "STALE_EVENT_CURSOR",
            message: "the index checkpoint changed; restart event pagination",
          });
        }

        const visibleCanonical =
          checkpoint === null
            ? eq(jobEvents.canonical, false)
            : or(
                eq(jobEvents.canonical, false),
                lte(jobEvents.blockNumber, checkpoint.blockNumber),
              )!;
        const clauses: SQL[] = [
          eq(jobEvents.networkId, this.#network),
          eq(jobEvents.jobId, jobId),
          or(eq(jobEvents.source, "operational"), visibleCanonical)!,
        ];
        if (query.source !== undefined) clauses.push(eq(jobEvents.source, query.source));
        if (afterEventId !== undefined) {
          clauses.push(gt(jobEvents.id, BigInt(afterEventId)));
        }

        const rows = await tx
          .select()
          .from(jobEvents)
          .where(and(...clauses))
          .orderBy(asc(jobEvents.id))
          .limit(query.limit + 1);
        const pageRows = rows.slice(0, query.limit);

        const orphanedRows = pageRows.filter((row) => row.source === "indexed" && !row.canonical);
        const replacementCandidates =
          orphanedRows.length === 0 || checkpoint === null
            ? []
            : await tx
                .select()
                .from(jobEvents)
                .where(
                  and(
                    eq(jobEvents.networkId, this.#network),
                    eq(jobEvents.jobId, jobId),
                    eq(jobEvents.source, "indexed"),
                    eq(jobEvents.canonical, true),
                    lte(jobEvents.blockNumber, checkpoint.blockNumber),
                    inArray(jobEvents.eventType, [
                      ...new Set(orphanedRows.map(({ eventType }) => eventType)),
                    ]),
                  ),
                )
                .orderBy(asc(jobEvents.id));

        const ids = pageRows.flatMap((row) => {
          const id = attemptId(row.payload);
          return id === undefined ? [] : [id];
        });
        const hashes = pageRows.flatMap((row) => (row.txHash === null ? [] : [row.txHash]));
        const attemptClauses: SQL[] = [];
        if (ids.length > 0) attemptClauses.push(inArray(transactionAttempts.id, [...new Set(ids)]));
        if (hashes.length > 0) {
          attemptClauses.push(inArray(transactionAttempts.txHash, [...new Set(hashes)]));
        }
        const attempts =
          attemptClauses.length === 0
            ? []
            : await tx
                .select()
                .from(transactionAttempts)
                .where(
                  and(
                    eq(transactionAttempts.networkId, this.#network),
                    eq(transactionAttempts.jobId, jobId),
                    or(...attemptClauses),
                  ),
                );
        const attemptIds = attempts.map(({ id }) => id);
        const receipts =
          attemptIds.length === 0
            ? []
            : await tx
                .select()
                .from(executorReceipts)
                .where(inArray(executorReceipts.attemptId, attemptIds));
        return {
          attempts,
          receipts,
          checkpoint,
          confirmationDepth: network.confirmationDepth,
          pageRows,
          hasNext: rows.length > query.limit,
          replacementCandidates,
        };
      },
      { accessMode: "read only", isolationLevel: "repeatable read" },
    );

    const attemptsById = new Map(result.attempts.map((attempt) => [attempt.id, attempt]));
    const attemptsByHash = new Map(
      result.attempts.flatMap((attempt) =>
        attempt.txHash === null ? [] : ([[attempt.txHash, attempt]] as const),
      ),
    );
    const receiptsByAttemptId = new Map(
      result.receipts.map((receipt) => [receipt.attemptId, receipt]),
    );
    const items = result.pageRows.map((row) => {
      const replacement = result.replacementCandidates.find(
        (candidate) => candidate.eventType === row.eventType && candidate.id > row.id,
      );
      const relatedAttempt =
        attemptsById.get(attemptId(row.payload) ?? "") ??
        (row.txHash === null ? undefined : attemptsByHash.get(row.txHash));
      return Object.freeze({
        eventId: row.id.toString(),
        jobId: row.jobId,
        eventType: row.eventType,
        category: category(row),
        source: row.source as EventSource,
        confidence: confidence(row, result.checkpoint, result.confirmationDepth),
        block: blockReference(row),
        attempt: attemptReference(
          relatedAttempt,
          relatedAttempt === undefined ? undefined : receiptsByAttemptId.get(relatedAttempt.id),
        ),
        replacement: replacementReference(replacement),
        details: details(row.payload),
        occurredAt: row.occurredAt.toISOString(),
        recordedAt: row.createdAt.toISOString(),
        orphanedAt: row.orphanedAt?.toISOString() ?? null,
      });
    });
    const last = result.pageRows.at(-1);
    const nextCursor =
      result.hasNext && last !== undefined
        ? encodeCursor({
            v: CURSOR_VERSION,
            f: filterFingerprint,
            c: checkpointKey(result.checkpoint),
            i: last.id.toString(),
          })
        : null;
    return Object.freeze({
      jobId,
      items: Object.freeze(items),
      page: Object.freeze({ limit: query.limit, nextCursor }),
      indexCheckpoint: result.checkpoint,
    });
  }

  async activity(input: Readonly<Record<string, unknown>>): Promise<ActivityTimeline> {
    const query = parseActivityQuery(input);
    const filterFingerprint = fingerprint(this.#network, query.jobId ?? "*", query.source);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor !== undefined && cursor.f !== filterFingerprint) {
      throw invalid("cursor does not match the requested activity filters");
    }

    const result = await this.#database.transaction(
      async (tx) => {
        const [network] = await tx
          .select({ confirmationDepth: networks.confirmationDepth })
          .from(networks)
          .where(eq(networks.id, this.#network))
          .limit(1);
        if (network === undefined) throw new Error("configured network is not initialized");

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
            code: "STALE_ACTIVITY_CURSOR",
            message: "the index checkpoint changed; restart activity pagination",
          });
        }

        const visibleCanonical =
          checkpoint === null
            ? eq(jobEvents.canonical, false)
            : or(
                eq(jobEvents.canonical, false),
                lte(jobEvents.blockNumber, checkpoint.blockNumber),
              )!;
        const clauses: SQL[] = [
          eq(jobEvents.networkId, this.#network),
          or(eq(jobEvents.source, "operational"), visibleCanonical)!,
        ];
        if (query.jobId !== undefined) clauses.push(eq(jobEvents.jobId, query.jobId));
        if (query.source !== undefined) clauses.push(eq(jobEvents.source, query.source));
        if (cursor !== undefined) clauses.push(lt(jobEvents.id, BigInt(cursor.i)));

        const rows = await tx
          .select()
          .from(jobEvents)
          .where(and(...clauses))
          .orderBy(desc(jobEvents.id))
          .limit(query.limit + 1);
        const pageRows = rows.slice(0, query.limit);
        const orphanedRows = pageRows.filter((row) => row.source === "indexed" && !row.canonical);
        const replacementCandidates =
          orphanedRows.length === 0 || checkpoint === null
            ? []
            : await tx
                .select()
                .from(jobEvents)
                .where(
                  and(
                    eq(jobEvents.networkId, this.#network),
                    eq(jobEvents.source, "indexed"),
                    eq(jobEvents.canonical, true),
                    lte(jobEvents.blockNumber, checkpoint.blockNumber),
                    inArray(jobEvents.jobId, [...new Set(orphanedRows.map(({ jobId }) => jobId))]),
                    inArray(jobEvents.eventType, [
                      ...new Set(orphanedRows.map(({ eventType }) => eventType)),
                    ]),
                  ),
                )
                .orderBy(asc(jobEvents.id));

        const ids = pageRows.flatMap((row) => {
          const id = attemptId(row.payload);
          return id === undefined ? [] : [id];
        });
        const hashes = pageRows.flatMap((row) => (row.txHash === null ? [] : [row.txHash]));
        const attemptClauses: SQL[] = [];
        if (ids.length > 0) attemptClauses.push(inArray(transactionAttempts.id, [...new Set(ids)]));
        if (hashes.length > 0) {
          attemptClauses.push(inArray(transactionAttempts.txHash, [...new Set(hashes)]));
        }
        const attempts =
          attemptClauses.length === 0
            ? []
            : await tx
                .select()
                .from(transactionAttempts)
                .where(
                  and(eq(transactionAttempts.networkId, this.#network), or(...attemptClauses)),
                );
        const attemptIds = attempts.map(({ id }) => id);
        const receipts =
          attemptIds.length === 0
            ? []
            : await tx
                .select()
                .from(executorReceipts)
                .where(inArray(executorReceipts.attemptId, attemptIds));
        return {
          attempts,
          checkpoint,
          confirmationDepth: network.confirmationDepth,
          hasNext: rows.length > query.limit,
          pageRows,
          receipts,
          replacementCandidates,
        };
      },
      { accessMode: "read only", isolationLevel: "repeatable read" },
    );

    const attemptsById = new Map(result.attempts.map((attempt) => [attempt.id, attempt]));
    const attemptsByHash = new Map(
      result.attempts.flatMap((attempt) =>
        attempt.txHash === null ? [] : ([[attempt.txHash, attempt]] as const),
      ),
    );
    const receiptsByAttemptId = new Map(
      result.receipts.map((receipt) => [receipt.attemptId, receipt]),
    );
    const items = result.pageRows.map((row) => {
      const replacement = result.replacementCandidates.find(
        (candidate) =>
          candidate.jobId === row.jobId &&
          candidate.eventType === row.eventType &&
          candidate.id > row.id,
      );
      const relatedAttempt =
        attemptsById.get(attemptId(row.payload) ?? "") ??
        (row.txHash === null ? undefined : attemptsByHash.get(row.txHash));
      return Object.freeze({
        eventId: row.id.toString(),
        jobId: row.jobId,
        eventType: row.eventType,
        category: category(row),
        source: row.source as EventSource,
        confidence: confidence(row, result.checkpoint, result.confirmationDepth),
        block: blockReference(row),
        attempt: attemptReference(
          relatedAttempt,
          relatedAttempt === undefined ? undefined : receiptsByAttemptId.get(relatedAttempt.id),
        ),
        replacement: replacementReference(replacement),
        details: details(row.payload),
        occurredAt: row.occurredAt.toISOString(),
        recordedAt: row.createdAt.toISOString(),
        orphanedAt: row.orphanedAt?.toISOString() ?? null,
      });
    });
    const last = result.pageRows.at(-1);
    const nextCursor =
      result.hasNext && last !== undefined
        ? encodeCursor({
            v: CURSOR_VERSION,
            f: filterFingerprint,
            c: checkpointKey(result.checkpoint),
            i: last.id.toString(),
          })
        : null;
    return Object.freeze({
      items: Object.freeze(items),
      page: Object.freeze({ limit: query.limit, nextCursor }),
      indexCheckpoint: result.checkpoint,
    });
  }
}

interface EventTimelineReader {
  timeline(
    jobId: string,
    query: Readonly<Record<string, unknown>>,
    options?: EventReadOptions,
  ): Promise<JobEventTimeline>;
}

export class JobEventStreamService {
  readonly #events: EventTimelineReader;
  readonly #heartbeatMs: number;
  readonly #now: () => Date;
  readonly #pollMs: number;

  constructor(events: EventTimelineReader, options: EventStreamOptions = {}) {
    this.#events = events;
    this.#heartbeatMs = options.heartbeatMs ?? EVENT_STREAM_HEARTBEAT_MS;
    this.#now = options.now ?? (() => new Date());
    this.#pollMs = options.pollMs ?? EVENT_STREAM_POLL_MS;
    if (!Number.isInteger(this.#heartbeatMs) || this.#heartbeatMs < 1) {
      throw new RangeError("heartbeatMs must be a positive integer");
    }
    if (!Number.isInteger(this.#pollMs) || this.#pollMs < 1) {
      throw new RangeError("pollMs must be a positive integer");
    }
  }

  stream(
    jobId: string,
    lastEventId: string | undefined,
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Observable<MessageEvent> {
    parseHash(jobId);
    const initialEventId = resumeEventId(lastEventId, cursor);

    return new Observable<MessageEvent>((subscriber) => {
      let currentEventId = initialEventId;
      let polling = false;
      let stopped = false;

      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
      };
      const onAbort = () => {
        stop();
        subscriber.complete();
      };
      const poll = async () => {
        if (polling || stopped) return;
        polling = true;
        try {
          for (let batch = 0; batch < EVENT_STREAM_MAX_BATCHES_PER_POLL; batch += 1) {
            const timeline = await this.#events.timeline(
              jobId,
              { limit: EVENT_STREAM_BATCH_SIZE },
              { afterEventId: currentEventId },
            );
            if (stopped) return;
            for (const item of timeline.items) {
              subscriber.next({
                data: item,
                id: item.eventId,
                retry: this.#pollMs,
                type: item.category === "transaction" ? "transaction-event" : "job-event",
              });
              currentEventId = item.eventId;
            }
            if (timeline.items.length < EVENT_STREAM_BATCH_SIZE) break;
          }
        } catch (error) {
          stop();
          subscriber.error(error);
        } finally {
          polling = false;
        }
      };
      const pollTimer = setInterval(() => void poll(), this.#pollMs);
      const heartbeatTimer = setInterval(() => {
        if (!stopped) {
          subscriber.next({ comment: `heartbeat ${this.#now().toISOString()}` });
        }
      }, this.#heartbeatMs);
      if (signal?.aborted) {
        stop();
        subscriber.complete();
        return stop;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void poll();

      return () => {
        stop();
        signal?.removeEventListener("abort", onAbort);
      };
    });
  }
}

export class JobEventStreamController {
  readonly #stream: JobEventStreamService;

  constructor(stream: JobEventStreamService) {
    this.#stream = stream;
  }

  stream(
    jobId: string,
    lastEventId: string | undefined,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Observable<MessageEvent> {
    return this.#stream.stream(jobId, lastEventId, cursor, signal);
  }
}

export class JobEventsController {
  readonly #events: JobEventsService;

  constructor(events: JobEventsService) {
    this.#events = events;
  }

  list(jobId: string, query: Readonly<Record<string, unknown>>): Promise<JobEventTimeline> {
    return this.#events.timeline(jobId, query);
  }
}

export class ActivityController {
  readonly #events: JobEventsService;

  constructor(events: JobEventsService) {
    this.#events = events;
  }

  list(query: Readonly<Record<string, unknown>>): Promise<ActivityTimeline> {
    return this.#events.activity(query);
  }
}

const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const decimalSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const blockSchema = {
  type: "object",
  required: ["number", "hash", "transactionHash", "transactionIndex"],
  properties: {
    number: decimalSchema,
    hash: hashSchema,
    transactionHash: hashSchema,
    transactionIndex: { ...decimalSchema, nullable: true },
  },
};
const attemptSchema = {
  type: "object",
  required: ["id", "operation", "state", "transactionHash", "committedBlockNumber", "receipt"],
  properties: {
    id: { type: "string", format: "uuid" },
    operation: { type: "string" },
    state: { type: "string" },
    transactionHash: { ...hashSchema, nullable: true },
    committedBlockNumber: { ...decimalSchema, nullable: true },
    receipt: {
      type: "object",
      nullable: true,
      required: ["id", "executorLockHash", "keyId", "signature", "payload", "createdAt"],
      properties: {
        id: { type: "string", format: "uuid" },
        executorLockHash: hashSchema,
        keyId: { type: "string" },
        signature: { type: "string", pattern: "^0x[0-9a-f]{128}$" },
        payload: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
      },
    },
  },
};
const replacementSchema = {
  type: "object",
  required: ["eventId", "eventType", "transactionHash", "block"],
  properties: {
    eventId: decimalSchema,
    eventType: { type: "string" },
    transactionHash: hashSchema,
    block: blockSchema,
  },
};
const eventSchema = {
  type: "object",
  required: [
    "eventId",
    "jobId",
    "eventType",
    "category",
    "source",
    "confidence",
    "block",
    "attempt",
    "replacement",
    "details",
    "occurredAt",
    "recordedAt",
    "orphanedAt",
  ],
  properties: {
    eventId: decimalSchema,
    jobId: hashSchema,
    eventType: { type: "string" },
    category: {
      type: "string",
      enum: ["lifecycle", "execution", "transaction", "notification", "operation"],
    },
    source: { type: "string", enum: [...EVENT_SOURCES] },
    confidence: { type: "string", enum: [...EVENT_CONFIDENCE] },
    block: { ...blockSchema, nullable: true },
    attempt: { ...attemptSchema, nullable: true },
    replacement: { ...replacementSchema, nullable: true },
    details: { type: "object", additionalProperties: true },
    occurredAt: { type: "string", format: "date-time" },
    recordedAt: { type: "string", format: "date-time" },
    orphanedAt: { type: "string", format: "date-time", nullable: true },
  },
};

Injectable()(JobEventsService);
Inject(JobEventsService)(JobEventsController, undefined, 0);
Inject(JobEventsService)(ActivityController, undefined, 0);
Inject(JobEventStreamService)(JobEventStreamController, undefined, 0);
Controller("jobs")(JobEventsController);
Controller("activity")(ActivityController);
Controller("events")(JobEventStreamController);
ApiTags("job events")(JobEventsController);
ApiTags("activity")(ActivityController);
ApiTags("job events")(JobEventStreamController);
Get(":jobId/events")(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);
Param("jobId")(JobEventsController.prototype, "list", 0);
Query()(JobEventsController.prototype, "list", 1);
ApiOperation({ summary: "Read an ordered job event timeline" })(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);
ApiParam({ name: "jobId", schema: hashSchema })(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);
ApiQuery({ name: "cursor", required: false, type: String })(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);
ApiQuery({
  name: "limit",
  required: false,
  type: Number,
  schema: { minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
})(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);
ApiQuery({ name: "source", required: false, enum: EVENT_SOURCES })(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["jobId", "items", "page", "indexCheckpoint"],
    properties: {
      jobId: hashSchema,
      items: { type: "array", items: eventSchema },
      page: {
        type: "object",
        required: ["limit", "nextCursor"],
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
          nextCursor: { type: "string", nullable: true },
        },
      },
      indexCheckpoint: {
        type: "object",
        nullable: true,
        required: ["blockNumber", "blockHash"],
        properties: { blockNumber: decimalSchema, blockHash: hashSchema },
      },
    },
  },
})(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);
ApiBadRequestResponse({ description: "Malformed job ID, filter, or cursor" })(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);
ApiConflictResponse({ description: "Index checkpoint changed during pagination" })(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);
ApiNotFoundResponse({ description: "Job not found" })(
  JobEventsController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(JobEventsController.prototype, "list")!,
);

Get()(
  ActivityController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(ActivityController.prototype, "list")!,
);
Query()(ActivityController.prototype, "list", 0);
ApiOperation({ summary: "Read recent public activity across jobs" })(
  ActivityController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(ActivityController.prototype, "list")!,
);
ApiQuery({ name: "cursor", required: false, type: String })(
  ActivityController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(ActivityController.prototype, "list")!,
);
ApiQuery({ name: "jobId", required: false, schema: hashSchema })(
  ActivityController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(ActivityController.prototype, "list")!,
);
ApiQuery({
  name: "limit",
  required: false,
  type: Number,
  schema: { minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
})(
  ActivityController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(ActivityController.prototype, "list")!,
);
ApiQuery({ name: "source", required: false, enum: EVENT_SOURCES })(
  ActivityController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(ActivityController.prototype, "list")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["items", "page", "indexCheckpoint"],
    properties: {
      items: { type: "array", items: eventSchema },
      page: {
        type: "object",
        required: ["limit", "nextCursor"],
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
          nextCursor: { type: "string", nullable: true },
        },
      },
      indexCheckpoint: {
        type: "object",
        nullable: true,
        required: ["blockNumber", "blockHash"],
        properties: { blockNumber: decimalSchema, blockHash: hashSchema },
      },
    },
  },
})(
  ActivityController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(ActivityController.prototype, "list")!,
);
ApiBadRequestResponse({ description: "Malformed activity filter or cursor" })(
  ActivityController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(ActivityController.prototype, "list")!,
);
ApiConflictResponse({ description: "Index checkpoint changed during pagination" })(
  ActivityController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(ActivityController.prototype, "list")!,
);

Sse("stream")(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
Query("jobId")(JobEventStreamController.prototype, "stream", 0);
Headers("last-event-id")(JobEventStreamController.prototype, "stream", 1);
Query("cursor")(JobEventStreamController.prototype, "stream", 2);
SseSignal()(JobEventStreamController.prototype, "stream", 3);
Header("Cache-Control", "no-cache, no-transform")(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
Header("X-Accel-Buffering", "no")(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
ApiOperation({
  summary: "Stream public job and transaction events with resumable event IDs",
})(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
ApiQuery({ name: "jobId", required: true, schema: hashSchema })(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
ApiQuery({
  name: "cursor",
  required: false,
  type: String,
  description: "Last delivered decimal event ID; Last-Event-ID takes precedence",
})(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
ApiProduces("text/event-stream")(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
ApiOkResponse({
  description: "Resumable stream of job-event, transaction-event, and heartbeat frames",
  schema: { type: "string" },
})(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
ApiBadRequestResponse({ description: "Malformed job ID or reconnect cursor" })(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
ApiNotFoundResponse({ description: "Job not found" })(
  JobEventStreamController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(JobEventStreamController.prototype, "stream")!,
);
