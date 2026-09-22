import { WORKSPACE_NAME } from "@ckb-automata/core";

export const API_APP_ID = `${WORKSPACE_NAME}:api` as const;

export { AppModule, createAppModule } from "./app.module.ts";
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
  NetworkMetadataController,
  NetworkMetadataService,
  SUPPORTED_POLICY_VERSIONS,
  type NetworkMetadata,
  type NetworkMetadataRpc,
} from "./network-metadata.ts";
export * as databaseSchema from "./database/schema.ts";
export {
  loadMigrations,
  migrateDatabase,
  rollbackDatabase,
  type AppliedMigration,
  type DatabaseMigration,
  type MigrationResult,
} from "./database/migrator.ts";
