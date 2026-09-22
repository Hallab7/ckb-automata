import { Module, type DynamicModule } from "@nestjs/common";

import type { AutomataEnvironment } from "@ckb-automata/config";

import { HealthController, HealthService, createDefaultHealthProbes } from "./health.ts";

// Nest uses the class identity as the root dependency-injection module token.
// oxlint-disable-next-line typescript/no-extraneous-class
export class AppModule {}

Module({ controllers: [HealthController] })(AppModule);

export function createAppModule(environment: AutomataEnvironment): DynamicModule {
  return {
    module: AppModule,
    providers: [
      {
        provide: HealthService,
        useFactory: () => new HealthService(createDefaultHealthProbes(environment)),
      },
    ],
  };
}
