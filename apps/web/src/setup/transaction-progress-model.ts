import type { ApiTransactionProgress } from "@ckb-automata/api-client";

const STORAGE_VERSION = 1;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;

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

export interface TransactionProgressPresentation {
  readonly detail: string;
  readonly title: string;
  readonly tone: "danger" | "neutral" | "success" | "warning";
}

const TRANSACTION_PROGRESS_PRESENTATIONS = {
  submitted: {
    title: "Submitted",
    detail: "The CKB node accepted the exact reviewed transaction.",
    tone: "neutral",
  },
  proposed: {
    title: "Proposed",
    detail: "The transaction is in the proposal window and is waiting for block inclusion.",
    tone: "neutral",
  },
  committed: {
    title: "Committed",
    detail: "The transaction is included and is accumulating confirmation depth.",
    tone: "neutral",
  },
  confirmed: {
    title: "Confirmed",
    detail: "The required canonical confirmation depth has been reached.",
    tone: "success",
  },
  dropped: {
    title: "Dropped",
    detail: "The transaction was not found after the propagation window.",
    tone: "danger",
  },
  conflicted: {
    title: "Conflicted",
    detail: "The node rejected the transaction, usually because an input was already consumed.",
    tone: "danger",
  },
  reorged: {
    title: "Reorged",
    detail: "The previously observed inclusion is no longer on the canonical chain.",
    tone: "warning",
  },
} as const satisfies Record<TransactionProgressState, TransactionProgressPresentation>;

export function transactionProgressPresentation(
  state: TransactionProgressState,
): TransactionProgressPresentation {
  return TRANSACTION_PROGRESS_PRESENTATIONS[state];
}

export function transactionConfirmationLabel(
  progress: Pick<ApiTransactionProgress, "confirmations" | "requiredConfirmations">,
): string {
  const observed = BigInt(progress.confirmations);
  const required = BigInt(progress.requiredConfirmations);
  return `${observed > required ? required : observed} / ${required}`;
}

export interface StoredTransactionProgress extends ApiTransactionProgress {
  readonly version: typeof STORAGE_VERSION;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function transactionProgressStorageKey(transactionHash: string): string {
  return `ckb-automata.transaction-progress.${transactionHash}`;
}

export function parseTransactionProgress(value: unknown): ApiTransactionProgress | undefined {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return record(JSON.parse(value));
          } catch {
            return undefined;
          }
        })()
      : record(value);
  if (parsed === undefined) return undefined;
  const block = parsed["block"] === null ? null : record(parsed["block"]);
  if (
    !HASH_PATTERN.test(String(parsed["transactionHash"] ?? "")) ||
    !TRANSACTION_PROGRESS_STATES.includes(parsed["state"] as TransactionProgressState) ||
    typeof parsed["confirmations"] !== "string" ||
    !DECIMAL_PATTERN.test(parsed["confirmations"]) ||
    !Number.isSafeInteger(parsed["requiredConfirmations"]) ||
    Number(parsed["requiredConfirmations"]) < 1 ||
    !canonicalDate(parsed["observedAt"]) ||
    !(parsed["reason"] === null || typeof parsed["reason"] === "string") ||
    (block !== null &&
      (typeof block?.["number"] !== "string" ||
        !DECIMAL_PATTERN.test(block["number"]) ||
        !HASH_PATTERN.test(String(block["hash"] ?? ""))))
  ) {
    return undefined;
  }
  return Object.freeze({
    transactionHash: parsed["transactionHash"] as string,
    state: parsed["state"] as TransactionProgressState,
    confirmations: parsed["confirmations"],
    requiredConfirmations: parsed["requiredConfirmations"] as number,
    block:
      block === null
        ? null
        : Object.freeze({ number: block["number"] as string, hash: block["hash"] as string }),
    observedAt: parsed["observedAt"],
    reason: parsed["reason"] as string | null,
  }) as ApiTransactionProgress;
}

export function readTransactionProgress(
  storage: Pick<Storage, "getItem">,
  transactionHash: string,
): ApiTransactionProgress | undefined {
  try {
    const progress = parseTransactionProgress(
      storage.getItem(transactionProgressStorageKey(transactionHash)),
    );
    return progress?.transactionHash === transactionHash ? progress : undefined;
  } catch {
    return undefined;
  }
}

export function writeTransactionProgress(
  storage: Pick<Storage, "setItem">,
  progress: ApiTransactionProgress,
): boolean {
  try {
    storage.setItem(
      transactionProgressStorageKey(progress.transactionHash),
      JSON.stringify({ ...progress, version: STORAGE_VERSION }),
    );
    return true;
  } catch {
    return false;
  }
}

export function progressQuery(
  submittedAt: string,
  previous: ApiTransactionProgress | undefined,
): {
  readonly submittedAt: string;
  readonly previousBlockNumber?: string;
  readonly previousBlockHash?: string;
} {
  return {
    submittedAt,
    ...(previous?.block === null || previous?.block === undefined
      ? {}
      : {
          previousBlockNumber: previous.block.number,
          previousBlockHash: previous.block.hash,
        }),
  };
}

export function initialTransactionProgress(
  transactionHash: string,
  submittedAt: string,
): ApiTransactionProgress {
  return Object.freeze({
    transactionHash,
    state: "submitted",
    confirmations: "0",
    requiredConfirmations: 1,
    block: null,
    observedAt: submittedAt,
    reason: null,
  });
}

export function sameTransactionProgress(
  left: ApiTransactionProgress | undefined,
  right: ApiTransactionProgress,
): boolean {
  return (
    left?.transactionHash === right.transactionHash &&
    left.state === right.state &&
    left.confirmations === right.confirmations &&
    left.requiredConfirmations === right.requiredConfirmations &&
    left.block?.number === right.block?.number &&
    left.block?.hash === right.block?.hash &&
    left.reason === right.reason
  );
}
