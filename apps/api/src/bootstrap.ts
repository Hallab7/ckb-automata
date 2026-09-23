import { isIP } from "node:net";

import { ValidationPipe, type INestApplication, type LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { parseEnvironment, type AutomataEnvironment } from "@ckb-automata/config";

import { createAppModule } from "./app.module.ts";
import {
  API_BODY_LIMIT_BYTES,
  API_REQUEST_RECEIVE_TIMEOUT_MS,
  ApiTimeoutInterceptor,
  installFastifyAbuseControls,
} from "./abuse-controls.ts";
import { createBackendLogger } from "./telemetry.ts";

export const API_GLOBAL_PREFIX = "v1" as const;
export const DEFAULT_API_HOST = "0.0.0.0" as const;
export const DEFAULT_API_PORT = 3001;

export interface ApiBootstrapConfig {
  readonly environment: AutomataEnvironment;
  readonly corsOrigins: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly trustedProxies: readonly string[];
}

export interface ApiBootstrapResult {
  readonly app: INestApplication;
  readonly config: ApiBootstrapConfig;
}

export interface ApiBootstrapDependencies {
  readonly createApplication?: (
    logger: LoggerService,
    config: ApiBootstrapConfig,
  ) => Promise<INestApplication>;
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

function parseOrigins(publicOrigin: string, value: string | undefined): readonly string[] {
  const entries = [new URL(publicOrigin).origin, ...(value?.split(",") ?? [])]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const url = new URL(entry);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        throw new TypeError("API_CORS_ORIGINS must contain HTTP(S) origins");
      }
      return url.origin;
    });
  if (value?.includes("*") ?? false) throw new TypeError("API_CORS_ORIGINS cannot use wildcards");
  return Object.freeze([...new Set(entries)]);
}

function parseTrustedProxies(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return Object.freeze([]);
  const entries = value.split(",").map((entry) => entry.trim().toLowerCase());
  if (entries.some((entry) => isIP(entry) === 0)) {
    throw new TypeError("API_TRUSTED_PROXIES must contain IP addresses");
  }
  return Object.freeze([...new Set(entries)]);
}

export function parseApiBootstrapConfig(
  input: Readonly<Record<string, string | undefined>>,
): ApiBootstrapConfig {
  const environment = parseEnvironment(input);
  return Object.freeze({
    environment,
    corsOrigins: parseOrigins(environment.PUBLIC_APP_ORIGIN, input["API_CORS_ORIGINS"]),
    host: parseHost(input["API_HOST"]),
    port: parsePort(input["API_PORT"]),
    trustedProxies: parseTrustedProxies(input["API_TRUSTED_PROXIES"]),
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
  app.useGlobalInterceptors(new ApiTimeoutInterceptor());
  app.setGlobalPrefix(API_GLOBAL_PREFIX);
  app.enableShutdownHooks();
}

async function createFastifyApplication(
  logger: LoggerService,
  config: ApiBootstrapConfig,
): Promise<INestApplication> {
  return NestFactory.create<NestFastifyApplication>(
    createAppModule(config.environment),
    (() => {
      const adapter = new FastifyAdapter({
        bodyLimit: API_BODY_LIMIT_BYTES,
        requestTimeout: API_REQUEST_RECEIVE_TIMEOUT_MS,
        routerOptions: { maxParamLength: 256 },
      });
      installFastifyAbuseControls(adapter.getInstance(), {
        allowedOrigins: config.corsOrigins,
        strictTransport: config.environment.AUTOMATA_PROFILE.startsWith("testnet-"),
        trustedProxies: config.trustedProxies,
      });
      return adapter;
    })(),
    {
      abortOnError: true,
      bufferLogs: true,
      logger,
    },
  );
}

export async function createApiApplication(
  input: Readonly<Record<string, string | undefined>>,
  dependencies: ApiBootstrapDependencies = {},
): Promise<ApiBootstrapResult> {
  const config = parseApiBootstrapConfig(input);
  const logger = dependencies.logger ?? createBackendLogger(config.environment);
  const app = await (dependencies.createApplication ?? createFastifyApplication)(logger, config);
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
