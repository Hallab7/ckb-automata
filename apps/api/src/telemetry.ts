import { performance } from "node:perf_hooks";

import {
  Controller,
  Get,
  Header,
  Inject,
  type CallHandler,
  type ExecutionContext,
  type LoggerService,
  type NestInterceptor,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, sql } from "drizzle-orm";
import { Observable } from "rxjs";

import type { AutomataEnvironment } from "@ckb-automata/config";
import {
  AutomataMetrics,
  CorrelatedLogger,
  ErrorReporter,
  TelemetryRuntime,
  correlationId,
  type LogWriter,
} from "@ckb-automata/telemetry";

import { CkbClient } from "./ckb-client.ts";
import { DatabaseClient } from "./database/client.ts";
import { indexerCheckpoints, jobEvents, jobs } from "./database/schema.ts";

const SERVICE_NAME = "ckb-automata-api";
const SERVICE_VERSION = "0.0.0";
const JOB_ID_PATTERN = /^0x[0-9a-f]{64}$/;

function configuredSecrets(environment: AutomataEnvironment): readonly string[] {
  return [
    environment.DATABASE_URL,
    environment.REDIS_URL,
    environment.WEBHOOK_ENCRYPTION_KEY,
    environment.ERROR_TRACKING_DSN,
    environment.OTEL_EXPORTER_OTLP_HEADERS,
  ].filter((value): value is string => value !== undefined && value !== "");
}

function otlpHeaders(value: string | undefined): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const headers: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator).trim().toLowerCase();
    const headerValue = entry.slice(separator + 1).trim();
    if (
      separator <= 0 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      headerValue === "" ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new TypeError("OTEL_EXPORTER_OTLP_HEADERS is malformed");
    }
    headers[name] = headerValue;
  }
  return Object.freeze(headers);
}

function release(environment: AutomataEnvironment): string {
  return environment.RELEASE_VERSION ?? SERVICE_VERSION;
}

function revision(environment: AutomataEnvironment): string {
  return environment.RELEASE_REVISION ?? "unversioned";
}

export class BackendTelemetry {
  readonly errors: ErrorReporter;
  readonly logger: CorrelatedLogger;
  readonly metrics = new AutomataMetrics();
  readonly runtime: TelemetryRuntime;
  readonly network: string;

  constructor(environment: AutomataEnvironment, options: { readonly writer?: LogWriter } = {}) {
    const secrets = configuredSecrets(environment);
    const exporterHeaders = otlpHeaders(environment.OTEL_EXPORTER_OTLP_HEADERS);
    this.network = environment.CKB_NETWORK;
    this.runtime = new TelemetryRuntime({
      environment: environment.AUTOMATA_PROFILE,
      ...(environment.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : { otlpEndpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT }),
      ...(exporterHeaders === undefined ? {} : { otlpHeaders: exporterHeaders }),
      release: release(environment),
      revision: revision(environment),
      serviceName: SERVICE_NAME,
      serviceVersion: SERVICE_VERSION,
    });
    this.logger = new CorrelatedLogger({
      configuredSecrets: secrets,
      context: () => this.runtime.current(),
      release: release(environment),
      revision: revision(environment),
      service: SERVICE_NAME,
      ...(options.writer === undefined
        ? environment.AUTOMATA_PROFILE === "test"
          ? { writer: () => undefined }
          : {}
        : { writer: options.writer }),
    });
    this.errors = new ErrorReporter({
      configuredSecrets: secrets,
      ...(environment.ERROR_TRACKING_DSN === undefined
        ? {}
        : { dsn: environment.ERROR_TRACKING_DSN }),
      environment: environment.AUTOMATA_PROFILE,
      release: release(environment),
      revision: revision(environment),
      service: SERVICE_NAME,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.runtime.shutdown(), this.errors.close()]);
  }
}

class NestTelemetryLogger implements LoggerService {
  readonly #logger: CorrelatedLogger;

  constructor(environment: AutomataEnvironment) {
    this.#logger = new CorrelatedLogger({
      configuredSecrets: configuredSecrets(environment),
      release: release(environment),
      revision: revision(environment),
      service: SERVICE_NAME,
    });
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.#write("info", message, optional);
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.#write("error", message, optional);
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.#write("warn", message, optional);
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.#write("debug", message, optional);
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.#write("debug", message, optional);
  }

  fatal(message: unknown, ...optional: unknown[]): void {
    this.#write("fatal", message, optional);
  }

  #write(
    level: "debug" | "info" | "warn" | "error" | "fatal",
    message: unknown,
    optional: readonly unknown[],
  ): void {
    const text = typeof message === "string" ? message : "framework event";
    this.#logger.write(level, `nestjs.${level}`, text, {
      ...(typeof message === "object" && message !== null ? { detail: message } : {}),
      ...(optional.length === 0
        ? {}
        : {
            context: optional.map((value) =>
              typeof value === "string" ? value.slice(0, 160) : value,
            ),
          }),
    });
  }
}

export function createBackendLogger(environment: AutomataEnvironment): LoggerService {
  return new NestTelemetryLogger(environment);
}

interface ApiRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly method: string;
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly url: string;
}

interface ApiResponse {
  readonly statusCode: number;
  header(name: string, value: string): void;
}

function header(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) return value;
  return value[0];
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "API_INTERNAL_FAILURE";
  const direct = Reflect.get(error, "code");
  if (typeof direct === "string") return direct;
  const response = Reflect.get(error, "response");
  if (typeof response === "object" && response !== null) {
    const nested = Reflect.get(response, "code");
    if (typeof nested === "string") return nested;
  }
  return "API_INTERNAL_FAILURE";
}

function errorStatus(error: unknown, fallback: number): number {
  if (typeof error !== "object" || error === null) return fallback;
  const getStatus = Reflect.get(error, "getStatus");
  if (typeof getStatus === "function") {
    const status = Reflect.apply(getStatus, error, []);
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }
  for (const key of ["status", "statusCode"] as const) {
    const status = Reflect.get(error, key);
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }
  return fallback;
}

export class ApiTelemetryInterceptor implements NestInterceptor {
  readonly #telemetry: BackendTelemetry;

  constructor(telemetry: BackendTelemetry) {
    this.#telemetry = telemetry;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<ApiRequest>();
    const response = http.getResponse<ApiResponse>();
    const requestCorrelationId = correlationId(header(request.headers["x-correlation-id"]));
    const possibleJobId = request.params?.["jobId"];
    const jobId =
      possibleJobId !== undefined && JOB_ID_PATTERN.test(possibleJobId) ? possibleJobId : undefined;
    response.header("x-correlation-id", requestCorrelationId);
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (path === "/v1/events/stream") return next.handle();

    return new Observable((subscriber) => {
      let inner: { unsubscribe(): void } | undefined;
      const started = performance.now();
      const execution = this.#telemetry.runtime.withCorrelation(
        { correlationId: requestCorrelationId, ...(jobId === undefined ? {} : { jobId }) },
        () =>
          this.#telemetry.runtime.withSpan(
            "api.request",
            {
              "http.request.method": request.method,
              "http.route": path,
            },
            async () => {
              try {
                await new Promise<void>((resolve, reject) => {
                  inner = next.handle().subscribe({
                    next: (value) => subscriber.next(value),
                    error: reject,
                    complete: resolve,
                  });
                });
                this.#telemetry.logger.info("api.request.completed", "API request completed", {
                  durationMs: Math.round((performance.now() - started) * 100) / 100,
                  method: request.method,
                  path,
                  statusCode: response.statusCode,
                });
              } catch (error) {
                const code = errorCode(error);
                const statusCode = errorStatus(error, response.statusCode);
                this.#telemetry.logger.error("api.request.failed", "API request failed", {
                  code,
                  durationMs: Math.round((performance.now() - started) * 100) / 100,
                  method: request.method,
                  path,
                  statusCode,
                });
                this.#telemetry.errors.capture(error, {
                  code,
                  correlationId: requestCorrelationId,
                  ...(jobId === undefined ? {} : { jobId }),
                  context: { method: request.method, path, statusCode },
                });
                throw error;
              }
            },
          ),
      );
      void execution.then(
        () => subscriber.complete(),
        (error: unknown) => subscriber.error(error),
      );
      return () => inner?.unsubscribe();
    });
  }
}

export class MetricsController {
  readonly #ckbClient: CkbClient;
  readonly #database: DatabaseClient;
  readonly #telemetry: BackendTelemetry;

  constructor(telemetry: BackendTelemetry, database: DatabaseClient, ckbClient: CkbClient) {
    this.#telemetry = telemetry;
    this.#database = database;
    this.#ckbClient = ckbClient;
  }

  async get(): Promise<string> {
    try {
      const latestEvents = this.#database.database
        .select({
          eventType: jobEvents.eventType,
          rank: sql<number>`row_number() over (partition by ${jobEvents.jobId} order by ${jobEvents.occurredAt} desc, ${jobEvents.id} desc)`.as(
            "event_rank",
          ),
        })
        .from(jobEvents)
        .where(and(eq(jobEvents.networkId, this.#telemetry.network), eq(jobEvents.canonical, true)))
        .orderBy(desc(jobEvents.occurredAt), desc(jobEvents.id))
        .as("latest_job_events");
      const [[jobCounts], [readyCounts], [checkpoint], tip] = await Promise.all([
        this.#database.database
          .select({
            live: sql<number>`count(*) FILTER (WHERE ${jobs.state} = 'live')::integer`,
          })
          .from(jobs)
          .where(eq(jobs.networkId, this.#telemetry.network)),
        this.#database.database
          .select({
            ready: sql<number>`count(*) FILTER (WHERE ${latestEvents.rank} = 1 AND ${latestEvents.eventType} = 'execution_ready')::integer`,
          })
          .from(latestEvents),
        this.#database.database
          .select({ blockNumber: indexerCheckpoints.blockNumber })
          .from(indexerCheckpoints)
          .where(eq(indexerCheckpoints.networkId, this.#telemetry.network))
          .limit(1),
        this.#ckbClient.getTipHeader(),
      ]);
      this.#telemetry.metrics.jobsLiveTotal.set(jobCounts?.live ?? 0);
      this.#telemetry.metrics.jobsReadyTotal.set(readyCounts?.ready ?? 0);
      if (checkpoint !== undefined) {
        this.#telemetry.metrics.indexerTipLagBlocks.set(
          Number(
            BigInt(tip.number) > BigInt(checkpoint.blockNumber)
              ? BigInt(tip.number) - BigInt(checkpoint.blockNumber)
              : 0n,
          ),
        );
      }
    } catch (error) {
      this.#telemetry.logger.warn("metrics.refresh.failed", "Live metric refresh failed", {
        code: errorCode(error),
      });
    }
    return this.#telemetry.metrics.render();
  }
}

Inject(BackendTelemetry)(ApiTelemetryInterceptor, undefined, 0);
Inject(BackendTelemetry)(MetricsController, undefined, 0);
Inject(DatabaseClient)(MetricsController, undefined, 1);
Inject(CkbClient)(MetricsController, undefined, 2);
Controller("metrics")(MetricsController);
ApiTags("operations")(MetricsController);
Get()(
  MetricsController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(MetricsController.prototype, "get")!,
);
Header("content-type", "text/plain; version=0.0.4; charset=utf-8")(
  MetricsController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(MetricsController.prototype, "get")!,
);
ApiOperation({ summary: "Read Prometheus service metrics" })(
  MetricsController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(MetricsController.prototype, "get")!,
);
ApiProduces("text/plain")(
  MetricsController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(MetricsController.prototype, "get")!,
);
ApiOkResponse({ schema: { type: "string" } })(
  MetricsController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(MetricsController.prototype, "get")!,
);
