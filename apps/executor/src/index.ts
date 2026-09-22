import { WORKSPACE_NAME } from "@ckb-automata/core";

export const EXECUTOR_APP_ID = `${WORKSPACE_NAME}:executor` as const;

export {
  ExecutorAdapterError,
  ExecutorAdapterRegistry,
  defineExecutorAdapter,
  runExecutorAdapter,
  type BuiltVerification,
  type EligibilityDecision,
  type ExecutorAdapterRegistration,
  type ExecutorBuild,
  type ExecutorCellSnapshot,
  type ExecutorContext,
  type ExecutorHeaderSnapshot,
  type ExecutorIdentity,
  type ExecutorPolicyAdapter,
  type ExecutorRunResult,
  type ExecutorSnapshot,
  type RegisteredExecutorAdapter,
} from "./adapter.ts";

export {
  DEADLINE_EXECUTOR_ADAPTER,
  DEADLINE_EXECUTOR_REGISTRATION,
  DeadlineAdapterError,
  type DeadlineAdapterErrorCode,
  type DeadlineEvidence,
  type DeadlineInspection,
  type DeadlineRefundRecord,
} from "./policies/deadline.ts";
export {
  RECURRING_EXECUTOR_ADAPTER,
  RECURRING_EXECUTOR_REGISTRATION,
  RecurringAdapterError,
  type RecurringAdapterErrorCode,
  type RecurringEvidence,
  type RecurringInspection,
} from "./policies/recurring.ts";
