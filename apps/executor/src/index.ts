import { WORKSPACE_NAME } from "@ckb-automata/core";

export const EXECUTOR_APP_ID = `${WORKSPACE_NAME}:executor` as const;

export {
  EXECUTOR_ADAPTERS,
  EXECUTOR_ENVIRONMENT,
  EXECUTOR_LOGGER,
  EXECUTOR_QUEUES,
  ExecutorModule,
  createExecutorModule,
  type ExecutorModuleDependencies,
} from "./app.module.ts";
export {
  ExecutorLogger,
  createExecutorApplication,
  startExecutor,
  type ExecutorBootstrapDependencies,
  type ExecutorBootstrapResult,
} from "./bootstrap.ts";
export {
  DEFAULT_QUEUE_PREFIX,
  MAX_QUEUE_DELAY_MS,
  QUEUE_READINESS_TIMEOUT_MS,
  QUEUE_POLICIES,
  DurableQueueRegistry,
  parseRedisConnection,
  queueRegistrationOptions,
  queueRootOptions,
  stableQueueJobId,
  type DeadLetterPayload,
  type QueueJobEnvelope,
  type QueuePolicy,
} from "./queues.ts";
export {
  ExecutorRuntime,
  type ExecutorChainClient,
  type ExecutorEventLogger,
  type ExecutorQueueReadiness,
  type ExecutorReadinessReport,
  type ExecutorRuntimeState,
} from "./runtime.ts";

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
