import { BullModule, getQueueToken } from "@nestjs/bullmq";
import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import type { Queue } from "bullmq";

import { createCkbClient, type CkbClient } from "@ckb-automata/ccc";
import type { AutomataEnvironment } from "@ckb-automata/config";

import { ExecutorAdapterRegistry, type RegisteredExecutorAdapter } from "./adapter.ts";
import { DEADLINE_EXECUTOR_ADAPTER } from "./policies/deadline.ts";
import { RECURRING_EXECUTOR_ADAPTER } from "./policies/recurring.ts";
import { DurableQueueRegistry, queueRegistrationOptions, queueRootOptions } from "./queues.ts";
import {
  ExecutorRuntime,
  type ExecutorChainClient,
  type ExecutorEventLogger,
  type ExecutorQueueReadiness,
} from "./runtime.ts";

export const EXECUTOR_ADAPTERS = Symbol("EXECUTOR_ADAPTERS");
export const EXECUTOR_ENVIRONMENT = Symbol("EXECUTOR_ENVIRONMENT");
export const EXECUTOR_LOGGER = Symbol("EXECUTOR_LOGGER");
export const EXECUTOR_QUEUES = Symbol("EXECUTOR_QUEUES");

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
  readonly queuePrefix?: string;
  readonly queues?: ExecutorQueueReadiness;
}

export function createExecutorModule(
  environment: AutomataEnvironment,
  dependencies: ExecutorModuleDependencies,
): DynamicModule {
  const adapters = Object.freeze([...(dependencies.adapters ?? DEFAULT_ADAPTERS)]);
  const registrations = queueRegistrationOptions();
  const imports =
    dependencies.queues === undefined
      ? [
          BullModule.forRoot(queueRootOptions(environment.REDIS_URL, dependencies.queuePrefix)),
          BullModule.registerQueue(...registrations),
        ]
      : [];
  const queueProviders: Provider[] =
    dependencies.queues === undefined
      ? [
          {
            provide: DurableQueueRegistry,
            inject: registrations.map(({ name }) => getQueueToken(name)),
            useFactory: (...queues: Queue[]) => new DurableQueueRegistry(queues),
          },
          { provide: EXECUTOR_QUEUES, useExisting: DurableQueueRegistry },
        ]
      : [{ provide: EXECUTOR_QUEUES, useValue: dependencies.queues }];
  return {
    module: ExecutorModule,
    imports,
    providers: [
      { provide: EXECUTOR_ENVIRONMENT, useValue: environment },
      { provide: EXECUTOR_ADAPTERS, useValue: adapters },
      { provide: EXECUTOR_LOGGER, useValue: dependencies.logger },
      ...queueProviders,
      {
        provide: ExecutorAdapterRegistry,
        inject: [EXECUTOR_ADAPTERS],
        useFactory: (registered: readonly RegisteredExecutorAdapter[]) =>
          new ExecutorAdapterRegistry(registered),
      },
      {
        provide: ExecutorRuntime,
        inject: [
          EXECUTOR_ENVIRONMENT,
          EXECUTOR_ADAPTERS,
          EXECUTOR_LOGGER,
          EXECUTOR_QUEUES,
          ExecutorAdapterRegistry,
        ],
        useFactory: (
          configured: AutomataEnvironment,
          registered: readonly RegisteredExecutorAdapter[],
          logger: ExecutorEventLogger,
          queues: ExecutorQueueReadiness,
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
            queues,
            registry,
            adapterIds: registered.map((adapter) => adapter.registration.id),
            logger,
          });
        },
      },
    ],
    exports: [ExecutorAdapterRegistry, ExecutorRuntime, EXECUTOR_QUEUES],
  };
}
