import {
  ClientPublicTestnet,
  type ClientBlock,
  type ClientBlockHeader,
  type Cell,
  type ClientFindCellsResponse,
  type ClientIndexerSearchKeyLike,
  type ClientTransactionResponse,
  type Hex,
  type HexLike,
  type Num,
  type NumLike,
  type OutPointLike,
  type OutputsValidator,
  type Owner,
  type TransactionLike,
} from "@ckb-ccc/shell";

import { parseBlockNumber, parseHash32, type BlockNumber, type Hash32 } from "@ckb-automata/core";
import type { AutomataMetrics, TelemetryRuntime } from "@ckb-automata/telemetry";

export type CkbClientErrorCode =
  | "CHAIN_READ_FAILED"
  | "INDEXER_READ_FAILED"
  | "DRY_RUN_FAILED"
  | "SUBMISSION_FAILED"
  | "CLIENT_CLOSED";

export class CkbClientError extends Error {
  readonly code: CkbClientErrorCode;

  constructor(code: CkbClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CkbClientError";
    this.code = code;
  }
}

export interface CkbIndexerTip {
  readonly blockNumber: BlockNumber;
  readonly blockHash: Hash32;
}

export interface CkbClientOptions {
  readonly rpcEndpoints: readonly [string, ...string[]];
  readonly indexerEndpoints: readonly [string, ...string[]];
  readonly timeoutMs?: number;
  readonly safeReadAttempts?: number;
  readonly retryDelayMs?: number;
  readonly metrics?: Pick<AutomataMetrics, "rpcErrorsTotal">;
  readonly telemetry?: Pick<TelemetryRuntime, "withSpan">;
}

export interface CkbReadClient {
  getGenesisHash(): Promise<Hash32>;
  getTipHeader(): Promise<ClientBlockHeader>;
  getIndexerTip(): Promise<CkbIndexerTip>;
  getBlockByNumber(blockNumber: NumLike): Promise<ClientBlock | undefined>;
  getBlockByHash(blockHash: HexLike): Promise<ClientBlock | undefined>;
  getCellLive(outPoint: OutPointLike): Promise<Cell | undefined>;
  findCellsPaged(
    key: ClientIndexerSearchKeyLike,
    order?: "asc" | "desc",
    limit?: NumLike,
    after?: string,
  ): Promise<ClientFindCellsResponse>;
  getTransactionStatus(txHash: HexLike): Promise<ClientTransactionResponse | undefined>;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_SAFE_READ_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 25;

function assertEndpoints(
  endpoints: readonly [string, ...string[]],
  name: string,
): readonly [string, ...string[]] {
  const unique = [
    ...new Set(
      endpoints.map((value) => {
        const url = new URL(value);
        if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
          throw new TypeError(`${name} endpoint uses an unsupported protocol`);
        }
        return url.href;
      }),
    ),
  ];
  if (unique.length === 0) throw new Error(`${name} requires at least one endpoint`);
  return unique as [string, ...string[]];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must not be negative`);
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CkbClient implements CkbReadClient {
  readonly #chainOwner: Owner<ClientPublicTestnet>;
  readonly #indexerOwner: Owner<ClientPublicTestnet>;
  readonly #senderOwner: Owner<ClientPublicTestnet>;
  readonly #safeReadAttempts: number;
  readonly #retryDelayMs: number;
  readonly #metrics: Pick<AutomataMetrics, "rpcErrorsTotal"> | undefined;
  readonly #telemetry: Pick<TelemetryRuntime, "withSpan"> | undefined;
  #closed = false;

  private constructor(
    chainOwner: Owner<ClientPublicTestnet>,
    indexerOwner: Owner<ClientPublicTestnet>,
    senderOwner: Owner<ClientPublicTestnet>,
    safeReadAttempts: number,
    retryDelayMs: number,
    instrumentation: Pick<CkbClientOptions, "metrics" | "telemetry">,
  ) {
    this.#chainOwner = chainOwner;
    this.#indexerOwner = indexerOwner;
    this.#senderOwner = senderOwner;
    this.#safeReadAttempts = safeReadAttempts;
    this.#retryDelayMs = retryDelayMs;
    this.#metrics = instrumentation.metrics;
    this.#telemetry = instrumentation.telemetry;
  }

  static open(options: CkbClientOptions): CkbClient {
    const rpcEndpoints = assertEndpoints(options.rpcEndpoints, "RPC client");
    const indexerEndpoints = assertEndpoints(options.indexerEndpoints, "indexer client");
    const timeout = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    const safeReadAttempts = positiveInteger(
      options.safeReadAttempts ?? DEFAULT_SAFE_READ_ATTEMPTS,
      "safeReadAttempts",
    );
    const retryDelayMs = nonNegativeInteger(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "retryDelayMs",
    );

    const chainOwner = ClientPublicTestnet.open({ urls: rpcEndpoints, timeout });
    const indexerOwner = ClientPublicTestnet.open({ urls: indexerEndpoints, timeout });
    // Writes deliberately receive no fallback endpoints.
    const senderOwner = ClientPublicTestnet.open({ urls: [rpcEndpoints[0]], timeout });
    return new CkbClient(chainOwner, indexerOwner, senderOwner, safeReadAttempts, retryDelayMs, {
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new CkbClientError("CLIENT_CLOSED", "CKB client is closed");
  }

  async #safeRead<T>(
    code: "CHAIN_READ_FAILED" | "INDEXER_READ_FAILED" | "DRY_RUN_FAILED",
    endpoint: "rpc" | "indexer",
    method: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      this.#assertOpen();
      let cause: unknown;
      for (let attempt = 1; attempt <= this.#safeReadAttempts; attempt += 1) {
        try {
          return await operation();
        } catch (error) {
          cause = error;
          if (attempt < this.#safeReadAttempts) await delay(this.#retryDelayMs);
        }
      }
      this.#metrics?.rpcErrorsTotal.inc({ endpoint, method });
      throw new CkbClientError(code, "CKB client operation failed", { cause });
    };
    return this.#telemetry === undefined
      ? run()
      : this.#telemetry.withSpan(`ckb.${endpoint}.${method}`, { "rpc.system": "ckb" }, run);
  }

  async getGenesisHash(): Promise<Hash32> {
    return this.#safeRead("CHAIN_READ_FAILED", "rpc", "get_block_hash", async () => {
      const result = await this.#chainOwner.value.requestor.request("get_block_hash", ["0x0"]);
      if (typeof result !== "string") throw new TypeError("genesis hash response is invalid");
      return parseHash32(result);
    });
  }

  getTipHeader(): Promise<ClientBlockHeader> {
    return this.#safeRead("CHAIN_READ_FAILED", "rpc", "get_tip_header", () =>
      this.#chainOwner.value.getTipHeader(),
    );
  }

  async getIndexerTip(): Promise<CkbIndexerTip> {
    return this.#safeRead("INDEXER_READ_FAILED", "indexer", "get_tip", async () => {
      const result = record(
        await this.#indexerOwner.value.requestor.request("get_tip", []),
        "indexer tip",
      );
      if (typeof result["block_number"] !== "string" || typeof result["block_hash"] !== "string") {
        throw new TypeError("indexer tip fields are invalid");
      }
      return Object.freeze({
        blockNumber: parseBlockNumber(result["block_number"]),
        blockHash: parseHash32(result["block_hash"]),
      });
    });
  }

  getBlockByNumber(blockNumber: NumLike): Promise<ClientBlock | undefined> {
    return this.#safeRead("CHAIN_READ_FAILED", "rpc", "get_block_by_number", () =>
      this.#chainOwner.value.getBlockByNumberNoCache(blockNumber),
    );
  }

  getBlockByHash(blockHash: HexLike): Promise<ClientBlock | undefined> {
    return this.#safeRead("CHAIN_READ_FAILED", "rpc", "get_block", () =>
      this.#chainOwner.value.getBlockByHashNoCache(blockHash),
    );
  }

  getCellLive(outPoint: OutPointLike): Promise<Cell | undefined> {
    return this.#safeRead("CHAIN_READ_FAILED", "rpc", "get_live_cell", () =>
      this.#chainOwner.value.getCellLiveNoCache(outPoint, true, false),
    );
  }

  findCellsPaged(
    key: ClientIndexerSearchKeyLike,
    order?: "asc" | "desc",
    limit?: NumLike,
    after?: string,
  ): Promise<ClientFindCellsResponse> {
    return this.#safeRead("INDEXER_READ_FAILED", "indexer", "get_cells", () =>
      this.#indexerOwner.value.findCellsPagedNoCache(key, order, limit, after),
    );
  }

  dryRun(transaction: TransactionLike, validator?: OutputsValidator): Promise<Num> {
    return this.#safeRead("DRY_RUN_FAILED", "rpc", "dry_run_transaction", () =>
      this.#chainOwner.value.sendTransactionDry(transaction, validator),
    );
  }

  async send(transaction: TransactionLike, validator?: OutputsValidator): Promise<Hex> {
    const run = async (): Promise<Hex> => {
      this.#assertOpen();
      try {
        return await this.#senderOwner.value.sendTransactionNoCache(transaction, validator);
      } catch (cause) {
        this.#metrics?.rpcErrorsTotal.inc({ endpoint: "rpc", method: "send_transaction" });
        throw new CkbClientError("SUBMISSION_FAILED", "CKB transaction submission failed", {
          cause,
        });
      }
    };
    return this.#telemetry === undefined
      ? run()
      : this.#telemetry.withSpan("ckb.rpc.send_transaction", { "rpc.system": "ckb" }, run);
  }

  getTransactionStatus(txHash: HexLike): Promise<ClientTransactionResponse | undefined> {
    return this.#safeRead("CHAIN_READ_FAILED", "rpc", "get_transaction", () =>
      this.#chainOwner.value.getTransactionNoCache(txHash),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([
      this.#chainOwner.dispose(),
      this.#indexerOwner.dispose(),
      this.#senderOwner.dispose(),
    ]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

export function createCkbClient(options: CkbClientOptions): CkbClient {
  return CkbClient.open(options);
}
