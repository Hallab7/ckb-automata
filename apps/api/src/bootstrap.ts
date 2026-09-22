import {
  ConsoleLogger,
  ValidationPipe,
  type INestApplication,
  type LoggerService,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { parseEnvironment, type AutomataEnvironment } from "@ckb-automata/config";

import { AppModule } from "./app.module.ts";

export const API_GLOBAL_PREFIX = "v1" as const;
export const DEFAULT_API_HOST = "0.0.0.0" as const;
export const DEFAULT_API_PORT = 3001;

export interface ApiBootstrapConfig {
  readonly environment: AutomataEnvironment;
  readonly host: string;
  readonly port: number;
}

export interface ApiBootstrapResult {
  readonly app: INestApplication;
  readonly config: ApiBootstrapConfig;
}

export interface ApiBootstrapDependencies {
  readonly createApplication?: (logger: LoggerService) => Promise<INestApplication>;
  readonly logger?: LoggerService;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_API_PORT;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new TypeError("API_PORT must be a decimal TCP port");
  }
  const port = Number(value);
  if (port > 65_535) throw new RangeError("API_PORT must be between 1 and 65535");
  return port;
}

function parseHost(value: string | undefined): string {
  const host = value?.trim() || DEFAULT_API_HOST;
  if (/[/\\\s]/.test(host)) throw new TypeError("API_HOST must be a hostname or IP address");
  return host;
}

export function parseApiBootstrapConfig(
  input: Readonly<Record<string, string | undefined>>,
): ApiBootstrapConfig {
  return Object.freeze({
    environment: parseEnvironment(input),
    host: parseHost(input["API_HOST"]),
    port: parsePort(input["API_PORT"]),
  });
}

export function configureApiApplication(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.setGlobalPrefix(API_GLOBAL_PREFIX);
  app.enableShutdownHooks();
}

function structuredLogger(): ConsoleLogger {
  return new ConsoleLogger("api-bootstrap", { json: true, timestamp: true });
}

async function createFastifyApplication(logger: LoggerService): Promise<INestApplication> {
  return NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    abortOnError: true,
    bufferLogs: true,
    logger,
  });
}

export async function createApiApplication(
  input: Readonly<Record<string, string | undefined>>,
  dependencies: ApiBootstrapDependencies = {},
): Promise<ApiBootstrapResult> {
  const config = parseApiBootstrapConfig(input);
  const logger = dependencies.logger ?? structuredLogger();
  const app = await (dependencies.createApplication ?? createFastifyApplication)(logger);
  configureApiApplication(app);
  return Object.freeze({ app, config });
}

export async function startApi(
  input: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: ApiBootstrapDependencies = {},
): Promise<ApiBootstrapResult> {
  const result = await createApiApplication(input, dependencies);
  await result.app.listen(result.config.port, result.config.host);
  return result;
}
