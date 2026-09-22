import { WORKSPACE_NAME } from "@ckb-automata/core";

export const API_APP_ID = `${WORKSPACE_NAME}:api` as const;

export { AppModule, createAppModule } from "./app.module.ts";
export {
  CkbClient,
  CkbClientError,
  createCkbClient,
  type CkbClientErrorCode,
  type CkbClientOptions,
  type CkbIndexerTip,
  type CkbReadClient,
} from "./ckb-client.ts";
export { DatabaseClient, createDatabaseClient, type AutomataDatabase } from "./database/client.ts";
export {
  CanonicalCheckpointStore,
  CheckpointError,
  DEFAULT_CANONICAL_ROLLBACK_WINDOW,
  planCheckpointTransition,
  type CanonicalBlockInput,
  type CanonicalPosition,
  type CheckpointErrorCode,
  type CheckpointUpdate,
} from "./indexer/checkpoints.ts";
export {
  JobCellDiscovery,
  extractSupportedJobCells,
  type DiscoveredJobCell,
  type JobCellExtraction,
  type JobDiscoveryResult,
  type SupportedJobPolicyKind,
} from "./indexer/job-discovery.ts";
export {
  JobTransitionIndexer,
  classifyJobTransition,
  type JobTransitionKind,
  type JobTransitionResult,
} from "./indexer/job-transitions.ts";
export {
  CanonicalBlockProjector,
  JobProjectionRollback,
  type CanonicalBlockProjectionResult,
  type ReorgRollbackResult,
} from "./indexer/reorg.ts";
export {
  API_GLOBAL_PREFIX,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  configureApiApplication,
  createApiApplication,
  parseApiBootstrapConfig,
  startApi,
  type ApiBootstrapConfig,
  type ApiBootstrapDependencies,
  type ApiBootstrapResult,
} from "./bootstrap.ts";
export {
  EVENT_CONFIDENCE,
  EVENT_SOURCES,
  EVENT_STREAM_BATCH_SIZE,
  EVENT_STREAM_HEARTBEAT_MS,
  EVENT_STREAM_POLL_MS,
  JobEventStreamController,
  JobEventStreamService,
  JobEventsController,
  JobEventsService,
  type EventConfidence,
  type EventSource,
  type EventStreamOptions,
  type JobEventReadModel,
  type JobEventTimeline,
} from "./events.ts";
export {
  HEALTH_DEPENDENCIES,
  HealthController,
  HealthService,
  createDefaultHealthProbes,
  type DependencyHealth,
  type HealthDependencyName,
  type HealthProbe,
  type LivenessReport,
  type ReadinessReport,
} from "./health.ts";
export {
  AccountJobsController,
  JOB_STATES,
  JOB_TEMPLATE_CATALOG,
  JOB_TEMPLATES,
  JobReadService,
  JobsController,
  TemplatesController,
  type JobListQuery,
  type JobListResponse,
  type JobReadModel,
  type JobSourceProvenance,
  type JobState,
  type JobTemplate,
  type JobTemplateId,
} from "./jobs.ts";
export {
  NetworkMetadataController,
  NetworkMetadataService,
  SUPPORTED_POLICY_VERSIONS,
  type NetworkMetadata,
  type NetworkMetadataChainClient,
} from "./network-metadata.ts";
export { createOpenApiDocument } from "./openapi.ts";
export {
  JOB_QUOTE_ASSUMPTIONS,
  JobQuoteController,
  JobQuoteService,
  type JobQuote,
  type QuoteChainClient,
} from "./quotes.ts";
export {
  TRANSACTION_OPERATIONS,
  TransactionBuildService,
  TransactionController,
  type SignedTransactionValidation,
  type TransactionBuildResponse,
  type TransactionChainClient,
  type TransactionOperation,
} from "./transactions.ts";
export * as databaseSchema from "./database/schema.ts";
export {
  loadMigrations,
  migrateDatabase,
  rollbackDatabase,
  type AppliedMigration,
  type DatabaseMigration,
  type MigrationResult,
} from "./database/migrator.ts";
