import { WORKSPACE_NAME } from "@ckb-automata/core";

export const EXECUTOR_APP_ID = `${WORKSPACE_NAME}:executor` as const;

export { ChainBuildSnapshotSource } from "./build-snapshot.ts";
export { PostgresBuildAttemptStore } from "./build-store.ts";
export { BuildCoordinator } from "./build-worker.ts";
export { PostgresConfirmationStore, MAX_CONFIRMATION_ATTEMPTS } from "./confirmation-store.ts";
export { CONFIRMATION_POLL_MS, ConfirmationCoordinator } from "./confirmation-worker.ts";
export {
  CONFIRMATION_DROP_AFTER_MS,
  ConfirmationService,
  deriveConfirmationTransition,
  type ConfirmationAttempt,
  type ConfirmationChain,
  type ConfirmationEvidence,
  type ConfirmationInclusion,
  type ConfirmationQueuePayload,
  type ConfirmationResult,
  type ConfirmationState,
  type ConfirmationStore,
  type ConfirmationTransition,
  type RpcTransactionObservation,
} from "./confirmation.ts";
export {
  BUILD_CLAIM_LEASE_MS,
  TransactionBuildService,
  createBuildAttemptId,
  type BuildAttemptClaim,
  type BuildAttemptStore,
  type BuildClaimResult,
  type BuildSnapshotSource,
  type TransactionBuildResult,
} from "./build.ts";
export {
  DISCOVERY_INTERVAL_MS,
  MAX_DISCOVERY_JOBS,
  EligibilityCoordinator,
  PostgresEligibilityJobSource,
  type EligibilityJobSource,
} from "./eligibility-worker.ts";
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
  MAX_EVALUATION_DELAY_MS,
  MIN_EVALUATION_DELAY_MS,
  TARGET_BLOCK_INTERVAL_MS,
  EligibilityEvaluator,
  nextEvaluationDelay,
  type BuildQueuePayload,
  type EligibilityEvaluationResult,
  type EligibilityJobRecord,
  type EligibilityQueuePayload,
} from "./eligibility.ts";
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
export { operatorLockArgs, signOperatorFeeInput } from "./signing.ts";
export {
  SimulationGateService,
  parseStoredTransaction,
  type SimulationAttempt,
  type SimulationChain,
  type SimulationQueuePayload,
  type SimulationRecord,
  type SimulationResult,
  type SimulationStore,
} from "./simulation.ts";
export { PostgresSimulationStore } from "./simulation-store.ts";
export { SimulationCoordinator } from "./simulation-worker.ts";
export { PostgresSubmissionStore } from "./submission-store.ts";
export {
  SubmissionError,
  SubmissionService,
  type SubmissionAcceptance,
  type SubmissionAttempt,
  type SubmissionChain,
  type SubmissionResult,
  type SubmissionStore,
} from "./submission.ts";

export {
  ExecutorAdapterError,
  ExecutorAdapterRegistry,
  defineExecutorAdapter,
  evaluateExecutorEligibility,
  runExecutorAdapter,
  type BuiltVerification,
  type EligibilityDecision,
  type ExecutorAdapterRegistration,
  type ExecutorBuild,
  type ExecutorCellSnapshot,
  type ExecutorContext,
  type ExecutorEligibilityContext,
  type ExecutorEligibilityResult,
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
