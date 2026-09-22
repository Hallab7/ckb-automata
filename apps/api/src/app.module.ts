import { Module, type DynamicModule } from "@nestjs/common";

import type { AutomataEnvironment } from "@ckb-automata/config";

import { CkbClient, createCkbClient } from "./ckb-client.ts";
import { HealthController, HealthService, createDefaultHealthProbes } from "./health.ts";
import { NetworkMetadataController, NetworkMetadataService } from "./network-metadata.ts";

// Nest uses the class identity as the root dependency-injection module token.
// oxlint-disable-next-line typescript/no-extraneous-class
export class AppModule {}

Module({ controllers: [HealthController, NetworkMetadataController] })(AppModule);

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
    ],
  };
}
