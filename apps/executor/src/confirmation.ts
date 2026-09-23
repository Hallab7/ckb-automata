import { parseBlockNumber, parseHash32, type Hash32 } from "@ckb-automata/core";

export const CONFIRMATION_DROP_AFTER_MS = 10 * 60_000;

export type ConfirmationState =
  "submitted" | "proposed" | "committed" | "confirmed" | "conflicted" | "dropped" | "reorged";

export interface ConfirmationQueuePayload {
  readonly attemptId: string;
  readonly transactionHash: Hash32;
}

export interface ConfirmationAttempt {
  readonly attemptId: string;
  readonly jobId: Hash32;
  readonly sequence: string;
  readonly transactionHash: Hash32;
  readonly state: "submitted" | "proposed" | "committed" | "reorged";
  readonly submittedAt: Date;
  readonly committedBlockNumber?: string;
}

export interface ConfirmationInclusion {
  readonly blockNumber: string;
  readonly blockHash: Hash32;
  readonly source: "indexed_event" | "rpc_canonical_block" | "orphaned_indexed_event";
}

export interface ConfirmationEvidence {
  readonly requiredDepth: number;
  readonly checkpointBlockNumber?: string;
  readonly inclusion?: ConfirmationInclusion;
  readonly conflict?: ConfirmationInclusion & {
    readonly transactionHash: Hash32;
    readonly executorLockHash?: Hash32;
    readonly successorOutPoint?: {
      readonly txHash: Hash32;
      readonly index: string;
    };
  };
  readonly reorg?: {
    readonly orphanedBlock: ConfirmationInclusion;
    readonly originalOutPoint: {
      readonly txHash: Hash32;
      readonly index: string;
    };
    readonly originalInputLive: boolean;
  };
}

export interface RpcTransactionObservation {
  readonly status: "sent" | "pending" | "proposed" | "committed" | "unknown" | "rejected";
  readonly transactionHash: Hash32;
  readonly blockNumber?: string;
  readonly blockHash?: Hash32;
  readonly reason?: string;
}

export interface ConfirmationTransition {
  readonly state: Exclude<ConfirmationState, "submitted">;
  readonly eventType: string;
  readonly observedStatus: string;
  readonly errorCode?: string;
  readonly block?: ConfirmationInclusion;
  readonly confirmations?: string;
  readonly requiredDepth?: number;
  readonly relatedTransactionHash?: Hash32;
  readonly winningExecutorLockHash?: Hash32;
  readonly successorOutPoint?: {
    readonly txHash: Hash32;
    readonly index: string;
  };
  readonly orphanedBlock?: ConfirmationInclusion;
  readonly originalOutPoint?: {
    readonly txHash: Hash32;
    readonly index: string;
  };
}

export interface ConfirmationStore {
  listPending(options?: {
    readonly afterAttemptId?: string;
    readonly limit?: number;
  }): Promise<readonly ConfirmationQueuePayload[]>;
  load(attemptId: string, transactionHash: Hash32): Promise<ConfirmationAttempt | undefined>;
  evidence(
    attempt: ConfirmationAttempt,
    rpc: RpcTransactionObservation | undefined,
  ): Promise<ConfirmationEvidence>;
  apply(attempt: ConfirmationAttempt, transition: ConfirmationTransition): Promise<boolean>;
}

export interface ConfirmationChain {
  getTransactionStatus(transactionHash: Hash32): Promise<
    | {
        readonly status: string;
        readonly transaction: { hash(): string };
        readonly blockNumber?: bigint | string | undefined;
        readonly blockHash?: string | undefined;
        readonly reason?: string | undefined;
      }
    | undefined
  >;
}

export interface ConfirmationRecovery {
  requeue(attempt: ConfirmationAttempt): Promise<void>;
}

export type ConfirmationResult =
  | { readonly status: "stale" | "unchanged" | "requeued" }
  | {
      readonly status: "transitioned";
      readonly state: Exclude<ConfirmationState, "submitted">;
    };

function confirmations(evidence: ConfirmationEvidence): bigint {
  if (!evidence.inclusion || evidence.checkpointBlockNumber === undefined) return 0n;
  const checkpoint = parseBlockNumber(evidence.checkpointBlockNumber);
  const committed = parseBlockNumber(evidence.inclusion.blockNumber);
  return checkpoint < committed ? 0n : checkpoint - committed + 1n;
}

export function deriveConfirmationTransition(
  attempt: ConfirmationAttempt,
  rpc: RpcTransactionObservation | undefined,
  evidence: ConfirmationEvidence,
  now: Date,
  dropAfterMs = CONFIRMATION_DROP_AFTER_MS,
): ConfirmationTransition | undefined {
  if (!Number.isSafeInteger(dropAfterMs) || dropAfterMs < 1) {
    throw new RangeError("confirmation drop threshold must be a positive integer");
  }
  if (!Number.isSafeInteger(evidence.requiredDepth) || evidence.requiredDepth < 1) {
    throw new RangeError("confirmation depth must be a positive integer");
  }
  if (evidence.inclusion) {
    const depth = confirmations(evidence);
    const confirmed = depth >= BigInt(evidence.requiredDepth);
    if (
      !confirmed &&
      attempt.state === "committed" &&
      attempt.committedBlockNumber === evidence.inclusion.blockNumber
    ) {
      return undefined;
    }
    return Object.freeze({
      state: confirmed ? "confirmed" : "committed",
      eventType: confirmed ? "transaction_confirmed" : "transaction_committed",
      observedStatus: rpc?.status ?? "unavailable",
      block: evidence.inclusion,
      confirmations: depth.toString(),
      requiredDepth: evidence.requiredDepth,
    });
  }
  if (evidence.conflict) {
    return Object.freeze({
      state: "conflicted",
      eventType: "transaction_conflicted",
      observedStatus: rpc?.status ?? "unavailable",
      errorCode: "EXECUTOR_ALREADY_CONSUMED",
      block: evidence.conflict,
      relatedTransactionHash: evidence.conflict.transactionHash,
      ...(evidence.conflict.executorLockHash === undefined
        ? {}
        : { winningExecutorLockHash: evidence.conflict.executorLockHash }),
      ...(evidence.conflict.successorOutPoint === undefined
        ? {}
        : { successorOutPoint: evidence.conflict.successorOutPoint }),
    });
  }
  if (
    evidence.reorg?.originalInputLive === true &&
    (attempt.state === "committed" || attempt.state === "reorged")
  ) {
    return Object.freeze({
      state: "reorged",
      eventType: "transaction_reorged",
      observedStatus: rpc?.status ?? "unavailable",
      errorCode: "EXECUTOR_TX_REORGED",
      orphanedBlock: evidence.reorg.orphanedBlock,
      originalOutPoint: evidence.reorg.originalOutPoint,
    });
  }
  if (rpc?.status === "proposed" && attempt.state === "submitted") {
    return Object.freeze({
      state: "proposed",
      eventType: "transaction_proposed",
      observedStatus: rpc.status,
    });
  }
  if (rpc?.status === "rejected" && attempt.state !== "committed") {
    return Object.freeze({
      state: "dropped",
      eventType: "transaction_dropped",
      observedStatus: rpc.status,
      errorCode: "EXECUTOR_NODE_REJECTED",
    });
  }
  const absent = rpc === undefined || rpc.status === "unknown";
  if (
    absent &&
    attempt.state !== "committed" &&
    now.getTime() - attempt.submittedAt.getTime() >= dropAfterMs
  ) {
    return Object.freeze({
      state: "dropped",
      eventType: "transaction_dropped",
      observedStatus: rpc?.status ?? "unavailable",
      errorCode: "EXECUTOR_TX_DROPPED",
    });
  }
  return undefined;
}

function rpcObservation(
  transactionHash: Hash32,
  response: Awaited<ReturnType<ConfirmationChain["getTransactionStatus"]>>,
): RpcTransactionObservation | undefined {
  if (!response) return undefined;
  const actualHash = parseHash32(response.transaction.hash());
  if (actualHash !== transactionHash) {
    throw new Error("confirmation RPC returned a transaction at the wrong hash");
  }
  if (
    !(["sent", "pending", "proposed", "committed", "unknown", "rejected"] as const).includes(
      response.status as never,
    )
  ) {
    throw new Error("confirmation RPC returned an unsupported transaction status");
  }
  const blockNumber =
    response.blockNumber === undefined
      ? undefined
      : parseBlockNumber(response.blockNumber.toString()).toString();
  const blockHash = response.blockHash === undefined ? undefined : parseHash32(response.blockHash);
  if ((blockNumber === undefined) !== (blockHash === undefined)) {
    throw new Error("confirmation RPC returned incomplete block provenance");
  }
  return Object.freeze({
    status: response.status as RpcTransactionObservation["status"],
    transactionHash: actualHash,
    ...(blockNumber === undefined ? {} : { blockNumber, blockHash: blockHash! }),
    ...(response.reason === undefined ? {} : { reason: response.reason }),
  });
}

export class ConfirmationService {
  readonly #store: ConfirmationStore;
  readonly #chain: ConfirmationChain;
  readonly #now: () => Date;
  readonly #dropAfterMs: number;
  readonly #recovery: ConfirmationRecovery | undefined;

  constructor(options: {
    readonly store: ConfirmationStore;
    readonly chain: ConfirmationChain;
    readonly now?: () => Date;
    readonly dropAfterMs?: number;
    readonly recovery?: ConfirmationRecovery;
  }) {
    this.#store = options.store;
    this.#chain = options.chain;
    this.#now = options.now ?? (() => new Date());
    this.#dropAfterMs = options.dropAfterMs ?? CONFIRMATION_DROP_AFTER_MS;
    this.#recovery = options.recovery;
  }

  async track(payload: ConfirmationQueuePayload): Promise<ConfirmationResult> {
    const transactionHash = parseHash32(payload.transactionHash);
    const attempt = await this.#store.load(payload.attemptId, transactionHash);
    if (!attempt) return Object.freeze({ status: "stale" });
    let rpc: RpcTransactionObservation | undefined;
    let rpcError: unknown;
    try {
      rpc = rpcObservation(
        transactionHash,
        await this.#chain.getTransactionStatus(transactionHash),
      );
    } catch (error) {
      rpcError = error;
    }
    const evidence = await this.#store.evidence(attempt, rpc);
    const transition = deriveConfirmationTransition(
      attempt,
      rpc,
      evidence,
      rpcError === undefined ? this.#now() : attempt.submittedAt,
      this.#dropAfterMs,
    );
    if (!transition) {
      if (rpcError !== undefined) throw rpcError;
      return Object.freeze({ status: "unchanged" });
    }
    if (transition.state === "reorged" && attempt.state === "reorged") {
      if (!this.#recovery) throw new Error("confirmation recovery queue is unavailable");
      await this.#recovery.requeue(attempt);
      return Object.freeze({ status: "requeued" });
    }
    if (!(await this.#store.apply(attempt, transition))) {
      return Object.freeze({ status: "stale" });
    }
    if (transition.state === "reorged") {
      if (!this.#recovery) throw new Error("confirmation recovery queue is unavailable");
      await this.#recovery.requeue(attempt);
    }
    return Object.freeze({ status: "transitioned", state: transition.state });
  }
}
