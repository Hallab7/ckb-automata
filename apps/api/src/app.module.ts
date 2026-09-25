import { Module, type DynamicModule } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";

import type { AutomataEnvironment } from "@ckb-automata/config";
import { deploymentRegistry } from "@ckb-automata/core";

import { CkbClient, createCkbClient } from "./ckb-client.ts";
import { AuthController, AuthService } from "./auth.ts";
import { DatabaseClient, createDatabaseClient } from "./database/client.ts";
import {
  ActivityController,
  JobEventStreamController,
  JobEventStreamService,
  JobEventsController,
  JobEventsService,
} from "./events.ts";
import { HealthController, HealthService, createDefaultHealthProbes } from "./health.ts";
import { CanonicalCheckpointStore } from "./indexer/checkpoints.ts";
import { JobCellDiscovery } from "./indexer/job-discovery.ts";
import { JobTransitionIndexer } from "./indexer/job-transitions.ts";
import { CanonicalBlockProjector, JobProjectionRollback } from "./indexer/reorg.ts";
import { LiveIndexerRuntime } from "./indexer/runtime.ts";
import {
  AccountJobsController,
  JobReadService,
  JobsController,
  TemplatesController,
} from "./jobs.ts";
import { NetworkMetadataController, NetworkMetadataService } from "./network-metadata.ts";
import {
  NotificationPreferencesController,
  NotificationPreferencesService,
} from "./preferences.ts";
import { JobQuoteController, JobQuoteService } from "./quotes.ts";
import { PostgresLockResolutionRecorder } from "./lock-resolutions.ts";
import { TransactionBuildService, TransactionController } from "./transactions.ts";
import {
  TransactionProgressController,
  TransactionProgressService,
  TransactionProgressStreamService,
} from "./transaction-progress.ts";
import { ApiTelemetryInterceptor, BackendTelemetry, MetricsController } from "./telemetry.ts";
import { WebhookController, WebhookService } from "./webhooks.ts";

// Nest uses the class identity as the root dependency-injection module token.
// oxlint-disable-next-line typescript/no-extraneous-class
export class AppModule {}

Module({
  controllers: [
    HealthController,
    AuthController,
    NotificationPreferencesController,
    WebhookController,
    MetricsController,
    NetworkMetadataController,
    JobsController,
    AccountJobsController,
    TemplatesController,
    ActivityController,
    JobEventsController,
    JobEventStreamController,
    JobQuoteController,
    TransactionController,
    TransactionProgressController,
  ],
})(AppModule);

export function createAppModule(environment: AutomataEnvironment): DynamicModule {
  return {
    module: AppModule,
    providers: [
      {
        provide: BackendTelemetry,
        useFactory: () => new BackendTelemetry(environment),
      },
      {
        provide: APP_INTERCEPTOR,
        inject: [BackendTelemetry],
        useFactory: (telemetry: BackendTelemetry) => new ApiTelemetryInterceptor(telemetry),
      },
      {
        provide: CkbClient,
        inject: [BackendTelemetry],
        useFactory: (telemetry: BackendTelemetry) =>
          createCkbClient({
            rpcEndpoints: [environment.CKB_RPC_URL],
            indexerEndpoints: [environment.CKB_INDEXER_URL],
            metrics: telemetry.metrics,
            telemetry: telemetry.runtime,
          }),
      },
      {
        provide: DatabaseClient,
        useFactory: () => createDatabaseClient(environment.DATABASE_URL),
      },
      {
        provide: AuthService,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new AuthService(databaseClient.database, environment),
      },
      {
        provide: NotificationPreferencesService,
        inject: [DatabaseClient, AuthService],
        useFactory: (databaseClient: DatabaseClient, auth: AuthService) =>
          new NotificationPreferencesService(databaseClient.database, auth, environment),
      },
      {
        provide: WebhookService,
        inject: [DatabaseClient, AuthService, BackendTelemetry],
        useFactory: (
          databaseClient: DatabaseClient,
          auth: AuthService,
          telemetry: BackendTelemetry,
        ) =>
          new WebhookService(databaseClient.database, auth, environment, {
            metrics: telemetry.metrics,
          }),
      },
      {
        provide: CanonicalCheckpointStore,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new CanonicalCheckpointStore(databaseClient.database),
      },
      {
        provide: JobCellDiscovery,
        inject: [DatabaseClient, CkbClient],
        useFactory: (databaseClient: DatabaseClient, ckbClient: CkbClient) =>
          new JobCellDiscovery(databaseClient.database, ckbClient),
      },
      {
        provide: JobTransitionIndexer,
        inject: [DatabaseClient, CkbClient],
        useFactory: (databaseClient: DatabaseClient, ckbClient: CkbClient) =>
          new JobTransitionIndexer(databaseClient.database, ckbClient),
      },
      {
        provide: JobProjectionRollback,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new JobProjectionRollback(databaseClient.database),
      },
      {
        provide: CanonicalBlockProjector,
        inject: [
          CkbClient,
          CanonicalCheckpointStore,
          JobProjectionRollback,
          JobCellDiscovery,
          JobTransitionIndexer,
          BackendTelemetry,
        ],
        useFactory: (
          ckbClient: CkbClient,
          checkpoints: CanonicalCheckpointStore,
          rollback: JobProjectionRollback,
          discovery: JobCellDiscovery,
          transitions: JobTransitionIndexer,
          telemetry: BackendTelemetry,
        ) =>
          new CanonicalBlockProjector(ckbClient, checkpoints, rollback, discovery, transitions, {
            metrics: telemetry.metrics,
            telemetry: telemetry.runtime,
          }),
      },
      {
        provide: LiveIndexerRuntime,
        inject: [CkbClient, CanonicalCheckpointStore, CanonicalBlockProjector, BackendTelemetry],
        useFactory: (
          ckbClient: CkbClient,
          checkpoints: CanonicalCheckpointStore,
          projector: CanonicalBlockProjector,
          telemetry: BackendTelemetry,
        ) =>
          new LiveIndexerRuntime(ckbClient, checkpoints, projector, telemetry.logger, {
            enabled: environment.AUTOMATA_PROFILE === "testnet-public",
            loadDeployment: async () => {
              const result = await deploymentRegistry.load(environment.CKB_GENESIS_HASH);
              if (result.status !== "ok") throw new Error("indexer deployment is unavailable");
              return result.deployment;
            },
          }),
      },
      {
        provide: HealthService,
        inject: [CkbClient, CanonicalCheckpointStore],
        useFactory: (ckbClient: CkbClient, checkpoints: CanonicalCheckpointStore) =>
          new HealthService(createDefaultHealthProbes(environment, ckbClient, checkpoints)),
      },
      {
        provide: NetworkMetadataService,
        inject: [CkbClient],
        useFactory: (ckbClient: CkbClient) => new NetworkMetadataService(environment, ckbClient),
      },
      {
        provide: JobReadService,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new JobReadService(databaseClient.database, environment.CKB_NETWORK),
      },
      {
        provide: JobEventsService,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new JobEventsService(databaseClient.database, environment.CKB_NETWORK),
      },
      {
        provide: JobEventStreamService,
        inject: [JobEventsService],
        useFactory: (events: JobEventsService) => new JobEventStreamService(events),
      },
      {
        provide: JobQuoteService,
        inject: [DatabaseClient, CkbClient],
        useFactory: (databaseClient: DatabaseClient, ckbClient: CkbClient) =>
          new JobQuoteService(databaseClient.database, environment.CKB_NETWORK, ckbClient),
      },
      {
        provide: PostgresLockResolutionRecorder,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new PostgresLockResolutionRecorder(databaseClient.database, environment.CKB_NETWORK),
      },
      {
        provide: TransactionBuildService,
        inject: [JobQuoteService, CkbClient, PostgresLockResolutionRecorder],
        useFactory: (
          quotes: JobQuoteService,
          ckbClient: CkbClient,
          resolutions: PostgresLockResolutionRecorder,
        ) =>
          new TransactionBuildService(quotes, ckbClient, environment.CKB_GENESIS_HASH, resolutions),
      },
      {
        provide: TransactionProgressService,
        inject: [CkbClient],
        useFactory: (ckbClient: CkbClient) =>
          new TransactionProgressService(environment, ckbClient),
      },
      {
        provide: TransactionProgressStreamService,
        inject: [TransactionProgressService],
        useFactory: (progress: TransactionProgressService) =>
          new TransactionProgressStreamService(progress),
      },
    ],
  };
}
