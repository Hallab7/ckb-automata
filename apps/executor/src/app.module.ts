import { Module, type DynamicModule } from "@nestjs/common";

import { createCkbClient, type CkbClient } from "@ckb-automata/ccc";
import type { AutomataEnvironment } from "@ckb-automata/config";

import { ExecutorAdapterRegistry, type RegisteredExecutorAdapter } from "./adapter.ts";
import { DEADLINE_EXECUTOR_ADAPTER } from "./policies/deadline.ts";
import { RECURRING_EXECUTOR_ADAPTER } from "./policies/recurring.ts";
import { ExecutorRuntime, type ExecutorChainClient, type ExecutorEventLogger } from "./runtime.ts";

export const EXECUTOR_ADAPTERS = Symbol("EXECUTOR_ADAPTERS");
export const EXECUTOR_ENVIRONMENT = Symbol("EXECUTOR_ENVIRONMENT");
export const EXECUTOR_LOGGER = Symbol("EXECUTOR_LOGGER");

const DEFAULT_ADAPTERS = Object.freeze([
  DEADLINE_EXECUTOR_ADAPTER,
  RECURRING_EXECUTOR_ADAPTER,
] satisfies readonly RegisteredExecutorAdapter[]);

// Nest uses the class identity as the root dependency-injection module token.
// oxlint-disable-next-line typescript/no-extraneous-class
export class ExecutorModule {}

Module({})(ExecutorModule);

export interface ExecutorModuleDependencies {
  readonly adapters?: readonly RegisteredExecutorAdapter[];
  readonly createChainClient?: (environment: AutomataEnvironment) => ExecutorChainClient;
  readonly logger: ExecutorEventLogger;
}

export function createExecutorModule(
  environment: AutomataEnvironment,
  dependencies: ExecutorModuleDependencies,
): DynamicModule {
  const adapters = Object.freeze([...(dependencies.adapters ?? DEFAULT_ADAPTERS)]);
  return {
    module: ExecutorModule,
    providers: [
      { provide: EXECUTOR_ENVIRONMENT, useValue: environment },
      { provide: EXECUTOR_ADAPTERS, useValue: adapters },
      { provide: EXECUTOR_LOGGER, useValue: dependencies.logger },
      {
        provide: ExecutorAdapterRegistry,
        inject: [EXECUTOR_ADAPTERS],
        useFactory: (registered: readonly RegisteredExecutorAdapter[]) =>
          new ExecutorAdapterRegistry(registered),
      },
      {
        provide: ExecutorRuntime,
        inject: [EXECUTOR_ENVIRONMENT, EXECUTOR_ADAPTERS, EXECUTOR_LOGGER, ExecutorAdapterRegistry],
        useFactory: (
          configured: AutomataEnvironment,
          registered: readonly RegisteredExecutorAdapter[],
          logger: ExecutorEventLogger,
          registry: ExecutorAdapterRegistry,
        ) => {
          const chain =
            dependencies.createChainClient?.(configured) ??
            (createCkbClient({
              rpcEndpoints: [configured.CKB_RPC_URL],
              indexerEndpoints: [configured.CKB_INDEXER_URL],
            }) satisfies CkbClient);
          return new ExecutorRuntime({
            environment: configured,
            chain,
            registry,
            adapterIds: registered.map((adapter) => adapter.registration.id),
            logger,
          });
        },
      },
    ],
    exports: [ExecutorAdapterRegistry, ExecutorRuntime],
  };
}
