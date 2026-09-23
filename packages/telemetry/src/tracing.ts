import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions";

export type TelemetryAttributes = Readonly<Record<string, string | number | boolean | undefined>>;
export type TraceCarrier = Record<string, string>;

export interface TelemetryRuntimeOptions {
  readonly environment: string;
  readonly exporter?: SpanExporter;
  readonly otlpEndpoint?: string;
  readonly otlpHeaders?: Readonly<Record<string, string>>;
  readonly release?: string;
  readonly revision?: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
}

interface CorrelationState {
  readonly correlationId: string;
  readonly jobId?: string;
  readonly otelContext: Context;
}

const CORRELATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCorrelationId(value: string): boolean {
  return CORRELATION_PATTERN.test(value);
}

export function correlationId(value: string | undefined): string {
  return value !== undefined && isCorrelationId(value) ? value : randomUUID();
}

function attributes(value: TelemetryAttributes): Attributes {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
}

function sanitizedException(error: unknown): Error {
  const sanitized = new Error(error instanceof Error ? error.name : "UnknownError");
  sanitized.name = error instanceof Error ? error.name : "UnknownError";
  return sanitized;
}

export class TelemetryRuntime {
  readonly #provider: NodeTracerProvider;
  readonly #propagator = new W3CTraceContextPropagator();
  readonly #storage = new AsyncLocalStorage<CorrelationState>();
  readonly #tracer;

  constructor(options: TelemetryRuntimeOptions) {
    const exporter =
      options.exporter ??
      (options.otlpEndpoint === undefined
        ? undefined
        : new OTLPTraceExporter({
            url: options.otlpEndpoint,
            ...(options.otlpHeaders === undefined ? {} : { headers: options.otlpHeaders }),
          }));
    this.#provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        [ATTR_SERVICE_VERSION]: options.serviceVersion,
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
        ...(options.release === undefined ? {} : { "service.release": options.release }),
        ...(options.revision === undefined ? {} : { "service.revision": options.revision }),
      }),
      ...(exporter === undefined ? {} : { spanProcessors: [new BatchSpanProcessor(exporter)] }),
    });
    this.#tracer = this.#provider.getTracer(options.serviceName, options.serviceVersion);
  }

  current(): Readonly<Omit<CorrelationState, "otelContext">> | undefined {
    const state = this.#storage.getStore();
    return state === undefined
      ? undefined
      : Object.freeze({
          correlationId: state.correlationId,
          ...(state.jobId === undefined ? {} : { jobId: state.jobId }),
        });
  }

  withCorrelation<T>(
    input: { readonly correlationId?: string; readonly jobId?: string },
    operation: () => T,
  ): T {
    const parent = this.#storage.getStore();
    const jobId = input.jobId ?? parent?.jobId;
    return this.#storage.run(
      {
        correlationId: correlationId(input.correlationId ?? parent?.correlationId),
        ...(jobId === undefined ? {} : { jobId }),
        otelContext: parent?.otelContext ?? ROOT_CONTEXT,
      },
      operation,
    );
  }

  withSpan<T>(
    name: string,
    spanAttributes: TelemetryAttributes,
    operation: () => Promise<T>,
  ): Promise<T> {
    const parent = this.#storage.getStore();
    const span = this.#tracer.startSpan(
      name,
      {
        attributes: attributes({
          ...spanAttributes,
          "automata.correlation_id": parent?.correlationId,
          "automata.job_id": parent?.jobId,
        }),
      },
      parent?.otelContext,
    );
    return this.#storage.run(
      {
        correlationId: parent?.correlationId ?? correlationId(undefined),
        ...(parent?.jobId === undefined ? {} : { jobId: parent.jobId }),
        otelContext: trace.setSpan(parent?.otelContext ?? ROOT_CONTEXT, span),
      },
      async () => this.#completeSpan(span, operation),
    );
  }

  withSpanSync<T>(name: string, spanAttributes: TelemetryAttributes, operation: () => T): T {
    const parent = this.#storage.getStore();
    const span = this.#tracer.startSpan(
      name,
      {
        attributes: attributes({
          ...spanAttributes,
          "automata.correlation_id": parent?.correlationId,
          "automata.job_id": parent?.jobId,
        }),
      },
      parent?.otelContext,
    );
    return this.#storage.run(
      {
        correlationId: parent?.correlationId ?? correlationId(undefined),
        ...(parent?.jobId === undefined ? {} : { jobId: parent.jobId }),
        otelContext: trace.setSpan(parent?.otelContext ?? ROOT_CONTEXT, span),
      },
      () => {
        try {
          const result = operation();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          this.#recordFailure(span, error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  inject(carrier: TraceCarrier = {}): TraceCarrier {
    const state = this.#storage.getStore();
    this.#propagator.inject(state?.otelContext ?? ROOT_CONTEXT, carrier, {
      set: (target, key, value) => {
        target[key] = String(value);
      },
    });
    if (state !== undefined) {
      carrier["x-correlation-id"] = state.correlationId;
      if (state.jobId !== undefined) carrier["x-automata-job-id"] = state.jobId;
    }
    return carrier;
  }

  extract<T>(carrier: Readonly<TraceCarrier>, operation: () => T): T {
    const extracted = this.#propagator.extract(ROOT_CONTEXT, carrier, {
      get: (source, key) => source[key],
      keys: (source) => Object.keys(source),
    });
    return this.#storage.run(
      {
        correlationId: correlationId(carrier["x-correlation-id"]),
        ...(carrier["x-automata-job-id"] === undefined
          ? {}
          : { jobId: carrier["x-automata-job-id"] }),
        otelContext: extracted,
      },
      operation,
    );
  }

  forceFlush(): Promise<void> {
    return this.#provider.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.#provider.shutdown();
  }

  async #completeSpan<T>(span: Span, operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      this.#recordFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  }

  #recordFailure(span: Span, error: unknown): void {
    span.recordException(sanitizedException(error));
    span.setStatus({ code: SpanStatusCode.ERROR });
    const code =
      typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
        ? String(Reflect.get(error, "code"))
        : "UNKNOWN";
    span.setAttribute("error.code", code);
  }
}
