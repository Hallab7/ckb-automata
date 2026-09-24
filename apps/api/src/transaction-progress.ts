import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Param,
  Query,
  ServiceUnavailableException,
  Sse,
  SseSignal,
  type MessageEvent,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Observable } from "rxjs";

import type { AutomataEnvironment } from "@ckb-automata/config";
import {
  deploymentRegistry,
  parseBlockNumber,
  parseHash32,
  type DeploymentRegistry,
  type Hash32,
} from "@ckb-automata/core";

import type { CkbReadClient } from "./ckb-client.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const DEFAULT_DROP_AFTER_MS = 10 * 60_000;
export const TRANSACTION_PROGRESS_POLL_MS = 3_000;
export const TRANSACTION_PROGRESS_HEARTBEAT_MS = 15_000;

export const TRANSACTION_PROGRESS_STATES = [
  "submitted",
  "proposed",
  "committed",
  "confirmed",
  "dropped",
  "conflicted",
  "reorged",
] as const;

export type TransactionProgressState = (typeof TRANSACTION_PROGRESS_STATES)[number];

export interface TransactionProgressBlock {
  readonly number: string;
  readonly hash: Hash32;
}

export interface TransactionProgress {
  readonly transactionHash: Hash32;
  readonly state: TransactionProgressState;
  readonly confirmations: string;
  readonly requiredConfirmations: number;
  readonly block: TransactionProgressBlock | null;
  readonly observedAt: string;
  readonly reason: string | null;
}

interface ProgressQuery {
  readonly submittedAt: Date;
  readonly previousBlock: TransactionProgressBlock | null;
}

export type TransactionProgressChainClient = Pick<
  CkbReadClient,
  "getBlockByNumber" | "getTipHeader" | "getTransactionStatus"
>;

interface TransactionProgressDependencies {
  readonly dropAfterMs?: number;
  readonly now?: () => Date;
  readonly registry?: DeploymentRegistry;
}

interface TransactionProgressStreamOptions {
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
}

interface TransactionProgressReader {
  read(
    transactionHash: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<TransactionProgress>;
}

function badRequest(message: string): BadRequestException {
  return new BadRequestException({
    status: "invalid_request",
    code: "INVALID_PROGRESS_QUERY",
    message,
  });
}

function parseHash(value: unknown, name: string): Hash32 {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw badRequest(`${name} must be a lowercase 32-byte hash`);
  }
  return parseHash32(value);
}

function parseQuery(input: Readonly<Record<string, unknown>>): ProgressQuery {
  const supported = new Set(["submittedAt", "previousBlockNumber", "previousBlockHash"]);
  if (Object.keys(input).some((key) => !supported.has(key))) {
    throw badRequest("transaction progress query contains unsupported fields");
  }
  const submittedAtValue = input["submittedAt"];
  if (typeof submittedAtValue !== "string") throw badRequest("submittedAt is required");
  const submittedAt = new Date(submittedAtValue);
  if (!Number.isFinite(submittedAt.getTime()) || submittedAt.toISOString() !== submittedAtValue) {
    throw badRequest("submittedAt must be a canonical ISO timestamp");
  }

  const numberValue = input["previousBlockNumber"];
  const hashValue = input["previousBlockHash"];
  if ((numberValue === undefined) !== (hashValue === undefined)) {
    throw badRequest("previous block number and hash must be provided together");
  }
  if (numberValue === undefined) return Object.freeze({ submittedAt, previousBlock: null });
  if (typeof numberValue !== "string" || !DECIMAL_PATTERN.test(numberValue)) {
    throw badRequest("previousBlockNumber must be canonical decimal");
  }
  return Object.freeze({
    submittedAt,
    previousBlock: Object.freeze({
      number: parseBlockNumber(numberValue).toString(),
      hash: parseHash(hashValue, "previousBlockHash"),
    }),
  });
}

function responseFingerprint(progress: TransactionProgress): string {
  return JSON.stringify({
    state: progress.state,
    confirmations: progress.confirmations,
    block: progress.block,
    reason: progress.reason,
  });
}

export class TransactionProgressService implements TransactionProgressReader {
  readonly #chain: TransactionProgressChainClient;
  readonly #dropAfterMs: number;
  readonly #environment: AutomataEnvironment;
  readonly #now: () => Date;
  readonly #registry: DeploymentRegistry;

  constructor(
    environment: AutomataEnvironment,
    chain: TransactionProgressChainClient,
    dependencies: TransactionProgressDependencies = {},
  ) {
    this.#environment = environment;
    this.#chain = chain;
    this.#dropAfterMs = dependencies.dropAfterMs ?? DEFAULT_DROP_AFTER_MS;
    this.#now = dependencies.now ?? (() => new Date());
    this.#registry = dependencies.registry ?? deploymentRegistry;
    if (!Number.isSafeInteger(this.#dropAfterMs) || this.#dropAfterMs < 1) {
      throw new RangeError("dropAfterMs must be a positive safe integer");
    }
  }

  async read(
    transactionHashInput: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<TransactionProgress> {
    const transactionHash = parseHash(transactionHashInput, "transactionHash");
    const query = parseQuery(input);
    const loaded = await this.#registry.load(this.#environment.CKB_GENESIS_HASH);
    if (loaded.status !== "ok" || loaded.deployment.network !== this.#environment.CKB_NETWORK) {
      throw new Error("configured deployment is unavailable");
    }
    const requiredConfirmations = loaded.deployment.confirmation.requiredDepth;
    const response = await this.#chain.getTransactionStatus(transactionHash);
    const now = this.#now();
    const base = {
      transactionHash,
      requiredConfirmations,
      observedAt: now.toISOString(),
    } as const;

    if (response !== undefined && parseHash32(response.transaction.hash()) !== transactionHash) {
      throw new Error("CKB RPC returned a transaction at the wrong hash");
    }
    const status = response?.status ?? "unknown";
    if (!["sent", "pending", "proposed", "committed", "unknown", "rejected"].includes(status)) {
      throw new Error("CKB RPC returned an unsupported transaction status");
    }

    if (status === "committed") {
      if (response?.blockNumber === undefined || response.blockHash === undefined) {
        throw new Error("committed transaction response has incomplete block provenance");
      }
      const block = Object.freeze({
        number: parseBlockNumber(response.blockNumber.toString()).toString(),
        hash: parseHash32(response.blockHash),
      });
      const [tip, canonicalBlock] = await Promise.all([
        this.#chain.getTipHeader(),
        this.#chain.getBlockByNumber(block.number),
      ]);
      if (canonicalBlock === undefined || parseHash32(canonicalBlock.header.hash) !== block.hash) {
        return Object.freeze({
          ...base,
          state: "reorged",
          confirmations: "0",
          block,
          reason: "The inclusion block is no longer canonical.",
        });
      }
      if (
        query.previousBlock !== null &&
        (query.previousBlock.number !== block.number || query.previousBlock.hash !== block.hash)
      ) {
        return Object.freeze({
          ...base,
          state: "reorged",
          confirmations: "0",
          block,
          reason: "The transaction moved to a different canonical inclusion block.",
        });
      }
      const tipNumber = parseBlockNumber(tip.number.toString());
      const blockNumber = parseBlockNumber(block.number);
      const confirmations = tipNumber < blockNumber ? 0n : tipNumber - blockNumber + 1n;
      return Object.freeze({
        ...base,
        state: confirmations >= BigInt(requiredConfirmations) ? "confirmed" : "committed",
        confirmations: confirmations.toString(),
        block,
        reason: null,
      });
    }

    if (query.previousBlock !== null && !["committed"].includes(status)) {
      return Object.freeze({
        ...base,
        state: "reorged",
        confirmations: "0",
        block: query.previousBlock,
        reason: "The previously observed inclusion is no longer reported by the node.",
      });
    }
    if (status === "rejected") {
      return Object.freeze({
        ...base,
        state: "conflicted",
        confirmations: "0",
        block: null,
        reason: response?.reason ?? "The node rejected the transaction.",
      });
    }
    if (status === "proposed") {
      return Object.freeze({
        ...base,
        state: "proposed",
        confirmations: "0",
        block: null,
        reason: null,
      });
    }
    const absent = response === undefined || status === "unknown";
    if (absent && now.getTime() - query.submittedAt.getTime() >= this.#dropAfterMs) {
      return Object.freeze({
        ...base,
        state: "dropped",
        confirmations: "0",
        block: null,
        reason: "The transaction remained absent beyond the propagation window.",
      });
    }
    return Object.freeze({
      ...base,
      state: "submitted",
      confirmations: "0",
      block: null,
      reason: null,
    });
  }
}

export class TransactionProgressStreamService {
  readonly #heartbeatMs: number;
  readonly #pollMs: number;
  readonly #progress: TransactionProgressReader;

  constructor(progress: TransactionProgressReader, options: TransactionProgressStreamOptions = {}) {
    this.#progress = progress;
    this.#heartbeatMs = options.heartbeatMs ?? TRANSACTION_PROGRESS_HEARTBEAT_MS;
    this.#pollMs = options.pollMs ?? TRANSACTION_PROGRESS_POLL_MS;
    if (!Number.isSafeInteger(this.#heartbeatMs) || this.#heartbeatMs < 1) {
      throw new RangeError("heartbeatMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#pollMs) || this.#pollMs < 1) {
      throw new RangeError("pollMs must be a positive safe integer");
    }
  }

  stream(
    transactionHash: string,
    query: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Observable<MessageEvent> {
    parseHash(transactionHash, "transactionHash");
    parseQuery(query);
    return new Observable<MessageEvent>((subscriber) => {
      let fingerprint: string | undefined;
      let polling = false;
      let sequence = 0;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
      };
      const poll = async () => {
        if (polling || stopped) return;
        polling = true;
        try {
          const progress = await this.#progress.read(transactionHash, query);
          const nextFingerprint = responseFingerprint(progress);
          if (!stopped && fingerprint !== nextFingerprint) {
            sequence += 1;
            fingerprint = nextFingerprint;
            subscriber.next({
              data: progress,
              id: sequence.toString(),
              retry: this.#pollMs,
              type: "transaction-progress",
            });
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
        if (!stopped) subscriber.next({ comment: "transaction-progress heartbeat" });
      }, this.#heartbeatMs);
      const onAbort = () => {
        stop();
        subscriber.complete();
      };
      if (signal?.aborted) {
        onAbort();
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

export class TransactionProgressController {
  readonly #progress: TransactionProgressService;
  readonly #stream: TransactionProgressStreamService;

  constructor(progress: TransactionProgressService, stream: TransactionProgressStreamService) {
    this.#progress = progress;
    this.#stream = stream;
  }

  async get(
    transactionHash: string,
    query: Readonly<Record<string, unknown>>,
  ): Promise<TransactionProgress> {
    try {
      return await this.#progress.read(transactionHash, query);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException({
        status: "unavailable",
        code: "TRANSACTION_PROGRESS_UNAVAILABLE",
      });
    }
  }

  stream(
    transactionHash: string,
    submittedAt: string,
    previousBlockNumber: string | undefined,
    previousBlockHash: string | undefined,
    signal: AbortSignal,
  ): Observable<MessageEvent> {
    return this.#stream.stream(
      transactionHash,
      {
        submittedAt,
        ...(previousBlockNumber === undefined ? {} : { previousBlockNumber }),
        ...(previousBlockHash === undefined ? {} : { previousBlockHash }),
      },
      signal,
    );
  }
}

const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const decimalSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const progressSchema = {
  type: "object",
  required: [
    "transactionHash",
    "state",
    "confirmations",
    "requiredConfirmations",
    "block",
    "observedAt",
    "reason",
  ],
  properties: {
    transactionHash: hashSchema,
    state: { type: "string", enum: [...TRANSACTION_PROGRESS_STATES] },
    confirmations: decimalSchema,
    requiredConfirmations: { type: "integer", minimum: 1 },
    block: {
      type: "object",
      nullable: true,
      required: ["number", "hash"],
      properties: { number: decimalSchema, hash: hashSchema },
    },
    observedAt: { type: "string", format: "date-time" },
    reason: { type: "string", nullable: true },
  },
};

Injectable()(TransactionProgressService);
Injectable()(TransactionProgressStreamService);
Inject(TransactionProgressService)(TransactionProgressController, undefined, 0);
Inject(TransactionProgressStreamService)(TransactionProgressController, undefined, 1);
Controller("transactions")(TransactionProgressController);
ApiTags("transactions")(TransactionProgressController);

Get(":transactionHash/progress")(
  TransactionProgressController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "get")!,
);
Param("transactionHash")(TransactionProgressController.prototype, "get", 0);
Query()(TransactionProgressController.prototype, "get", 1);
ApiOperation({ summary: "Read current transaction progress from the canonical chain" })(
  TransactionProgressController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "get")!,
);
ApiParam({ name: "transactionHash", schema: hashSchema })(
  TransactionProgressController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "get")!,
);
ApiQuery({ name: "submittedAt", required: true, type: String })(
  TransactionProgressController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "get")!,
);
ApiQuery({ name: "previousBlockNumber", required: false, schema: decimalSchema })(
  TransactionProgressController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "get")!,
);
ApiQuery({ name: "previousBlockHash", required: false, schema: hashSchema })(
  TransactionProgressController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "get")!,
);
ApiOkResponse({ schema: progressSchema })(
  TransactionProgressController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "get")!,
);
ApiBadRequestResponse({ description: "Malformed transaction hash or progress context" })(
  TransactionProgressController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "get")!,
);
ApiServiceUnavailableResponse({ description: "CKB progress read unavailable" })(
  TransactionProgressController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "get")!,
);

Sse(":transactionHash/progress/stream")(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
Param("transactionHash")(TransactionProgressController.prototype, "stream", 0);
Query("submittedAt")(TransactionProgressController.prototype, "stream", 1);
Query("previousBlockNumber")(TransactionProgressController.prototype, "stream", 2);
Query("previousBlockHash")(TransactionProgressController.prototype, "stream", 3);
SseSignal()(TransactionProgressController.prototype, "stream", 4);
Header("Cache-Control", "no-cache, no-transform")(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
Header("X-Accel-Buffering", "no")(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
ApiOperation({ summary: "Stream current transaction progress with reconnect-safe snapshots" })(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
ApiParam({ name: "transactionHash", schema: hashSchema })(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
ApiQuery({ name: "submittedAt", required: true, type: String })(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
ApiQuery({ name: "previousBlockNumber", required: false, schema: decimalSchema })(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
ApiQuery({ name: "previousBlockHash", required: false, schema: hashSchema })(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
ApiProduces("text/event-stream")(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
ApiOkResponse({
  description: "Transaction progress and heartbeat frames",
  schema: { type: "string" },
})(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
ApiBadRequestResponse({ description: "Malformed transaction hash or progress context" })(
  TransactionProgressController.prototype,
  "stream",
  Object.getOwnPropertyDescriptor(TransactionProgressController.prototype, "stream")!,
);
