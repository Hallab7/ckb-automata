import { UnrecoverableError } from "bullmq";

import { ERROR_CATALOG, type ErrorKey } from "@ckb-automata/core";

export type ExecutorFailureCode = {
  [Key in ErrorKey]: (typeof ERROR_CATALOG)[Key]["domain"] extends "executor" ? Key : never;
}[ErrorKey];

export type RetryCategory =
  | "retryable"
  | "terminal-invalid"
  | "consumed-by-other"
  | "unsupported"
  | "cancelled"
  | "expired"
  | "recovery-required";

export interface ExecutorRetryPolicy {
  readonly category: RetryCategory;
  readonly retryable: boolean;
  readonly maxAttempts: number;
}

const RETRYABLE_ATTEMPTS = 12;

function retryable(): ExecutorRetryPolicy {
  return Object.freeze({ category: "retryable", retryable: true, maxAttempts: RETRYABLE_ATTEMPTS });
}

function terminal(category: Exclude<RetryCategory, "retryable">): ExecutorRetryPolicy {
  return Object.freeze({ category, retryable: false, maxAttempts: 1 });
}

export const EXECUTOR_RETRY_POLICIES = Object.freeze({
  EXECUTOR_NOT_YET_ELIGIBLE: retryable(),
  EXECUTOR_PREPARE_WINDOW_MISSED: terminal("expired"),
  EXECUTOR_ALREADY_CONSUMED: terminal("consumed-by-other"),
  EXECUTOR_INPUT_CONFLICT: terminal("consumed-by-other"),
  EXECUTOR_INSUFFICIENT_JOB_BUDGET: terminal("terminal-invalid"),
  EXECUTOR_REWARD_BELOW_MINIMUM: terminal("terminal-invalid"),
  EXECUTOR_POLICY_VERSION_UNSUPPORTED: terminal("unsupported"),
  EXECUTOR_PAYLOAD_HASH_MISMATCH: terminal("terminal-invalid"),
  EXECUTOR_INVALID_APPLICATION_STATE: terminal("terminal-invalid"),
  EXECUTOR_MISSING_HEADER: retryable(),
  EXECUTOR_IMMATURE_SINCE: retryable(),
  EXECUTOR_SIMULATION_REJECTED: terminal("terminal-invalid"),
  EXECUTOR_NODE_REJECTED: terminal("terminal-invalid"),
  EXECUTOR_FEE_INPUT_UNAVAILABLE: retryable(),
  EXECUTOR_TX_DROPPED: retryable(),
  EXECUTOR_TX_REORGED: retryable(),
  EXECUTOR_JOB_EXPIRED: terminal("expired"),
  EXECUTOR_JOB_CANCELLED: terminal("cancelled"),
  EXECUTOR_RECOVERY_REQUIRED: terminal("recovery-required"),
  EXECUTOR_BUILD_FAILED: retryable(),
  EXECUTOR_ADAPTER_MISMATCH: terminal("unsupported"),
  EXECUTOR_BUILD_CLAIM_LOST: retryable(),
  EXECUTOR_CHAIN_SNAPSHOT_MOVED: retryable(),
  EXECUTOR_STALE_OUTPOINT: terminal("consumed-by-other"),
  EXECUTOR_BUILD_RECORD_INVALID: terminal("terminal-invalid"),
  EXECUTOR_FEE_MISMATCH: terminal("terminal-invalid"),
  EXECUTOR_REWARD_INVALID: terminal("terminal-invalid"),
  EXECUTOR_CYCLE_LIMIT_EXCEEDED: terminal("terminal-invalid"),
  EXECUTOR_UNPROFITABLE: terminal("terminal-invalid"),
  EXECUTOR_SUBMISSION_RECORD_INVALID: terminal("terminal-invalid"),
  EXECUTOR_SUBMISSION_HASH_MISMATCH: terminal("terminal-invalid"),
} satisfies Readonly<Record<ExecutorFailureCode, ExecutorRetryPolicy>>);

const FAILURE_ALIASES = Object.freeze({
  INVALID_SNAPSHOT: "EXECUTOR_BUILD_RECORD_INVALID",
  UNSUPPORTED_POLICY: "EXECUTOR_POLICY_VERSION_UNSUPPORTED",
  DUPLICATE_ADAPTER: "EXECUTOR_ADAPTER_MISMATCH",
  INVALID_CAMPAIGN: "EXECUTOR_INVALID_APPLICATION_STATE",
  INVALID_RECURRING_JOB: "EXECUTOR_INVALID_APPLICATION_STATE",
  INVALID_COMMITMENT: "EXECUTOR_PAYLOAD_HASH_MISMATCH",
  MISSING_RESOLUTION: "EXECUTOR_INVALID_APPLICATION_STATE",
  INVALID_FEE_CELL: "EXECUTOR_FEE_INPUT_UNAVAILABLE",
  UNSUPPORTED_CLAIM: "EXECUTOR_INVALID_APPLICATION_STATE",
  AMBIGUOUS_PAYOUT: "EXECUTOR_INVALID_APPLICATION_STATE",
} satisfies Readonly<Record<string, ExecutorFailureCode>>);

export function normalizeExecutorFailureCode(code: string): ExecutorFailureCode | undefined {
  const alias = Reflect.get(FAILURE_ALIASES, code) as ExecutorFailureCode | undefined;
  if (alias !== undefined) return alias;
  if (!Object.hasOwn(ERROR_CATALOG, code)) return undefined;
  const key = code as ErrorKey;
  return ERROR_CATALOG[key].domain === "executor" ? (key as ExecutorFailureCode) : undefined;
}

export function executorFailureCode(error: unknown): ExecutorFailureCode | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth <= 6; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return undefined;
    seen.add(current);
    const code = Reflect.get(current, "code");
    if (typeof code === "string") {
      const normalized = normalizeExecutorFailureCode(code);
      if (normalized !== undefined) return normalized;
    }
    current = Reflect.get(current, "cause");
  }
  return undefined;
}

export function retryPolicyFor(error: unknown): ExecutorRetryPolicy | undefined {
  const code = executorFailureCode(error);
  return code === undefined ? undefined : EXECUTOR_RETRY_POLICIES[code];
}

function unrecoverable(code: ExecutorFailureCode, cause: unknown): UnrecoverableError {
  const error = new UnrecoverableError(code);
  Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}

export async function executeWithRetryPolicy<T>(
  operation: () => Promise<T>,
  attemptsMade = 0,
): Promise<T> {
  if (!Number.isSafeInteger(attemptsMade) || attemptsMade < 0) {
    throw new RangeError("attempt count must be a non-negative integer");
  }
  try {
    return await operation();
  } catch (error) {
    const code = executorFailureCode(error);
    if (code === undefined) throw error;
    const policy = EXECUTOR_RETRY_POLICIES[code];
    if (!policy.retryable || attemptsMade + 1 >= policy.maxAttempts) {
      throw unrecoverable(code, error);
    }
    throw error;
  }
}
