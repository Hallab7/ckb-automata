import { Module, type DynamicModule } from "@nestjs/common";

import type { AutomataEnvironment } from "@ckb-automata/config";

import { CkbClient, createCkbClient } from "./ckb-client.ts";
import { DatabaseClient, createDatabaseClient } from "./database/client.ts";
import { JobEventsController, JobEventsService } from "./events.ts";
import { HealthController, HealthService, createDefaultHealthProbes } from "./health.ts";
import { CanonicalCheckpointStore } from "./indexer/checkpoints.ts";
import { JobCellDiscovery } from "./indexer/job-discovery.ts";
import { JobTransitionIndexer } from "./indexer/job-transitions.ts";
import { CanonicalBlockProjector, JobProjectionRollback } from "./indexer/reorg.ts";
import {
  AccountJobsController,
  JobReadService,
  JobsController,
  TemplatesController,
} from "./jobs.ts";
import { NetworkMetadataController, NetworkMetadataService } from "./network-metadata.ts";
import { JobQuoteController, JobQuoteService } from "./quotes.ts";

// Nest uses the class identity as the root dependency-injection module token.
// oxlint-disable-next-line typescript/no-extraneous-class
export class AppModule {}

Module({
  controllers: [
    HealthController,
    NetworkMetadataController,
    JobsController,
    AccountJobsController,
    TemplatesController,
    JobEventsController,
    JobQuoteController,
  ],
})(AppModule);

export function createAppModule(environment: AutomataEnvironment): DynamicModule {
  return {
    module: AppModule,
    providers: [
      {
        provide: CkbClient,
        useFactory: () =>
          createCkbClient({
            rpcEndpoints: [environment.CKB_RPC_URL],
            indexerEndpoints: [environment.CKB_INDEXER_URL],
          }),
      },
      {
        provide: DatabaseClient,
        useFactory: () => createDatabaseClient(environment.DATABASE_URL),
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
        ],
        useFactory: (
          ckbClient: CkbClient,
          checkpoints: CanonicalCheckpointStore,
          rollback: JobProjectionRollback,
          discovery: JobCellDiscovery,
          transitions: JobTransitionIndexer,
        ) => new CanonicalBlockProjector(ckbClient, checkpoints, rollback, discovery, transitions),
      },
      {
        provide: HealthService,
        inject: [CkbClient],
        useFactory: (ckbClient: CkbClient) =>
          new HealthService(createDefaultHealthProbes(environment, ckbClient)),
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
        provide: JobQuoteService,
        inject: [DatabaseClient, CkbClient],
        useFactory: (databaseClient: DatabaseClient, ckbClient: CkbClient) =>
          new JobQuoteService(databaseClient.database, environment.CKB_NETWORK, ckbClient),
      },
    ],
  };
}
