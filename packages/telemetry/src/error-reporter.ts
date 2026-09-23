import { captureException, flush, init } from "@sentry/node";

import { redactLogRecord } from "@ckb-automata/config";

export interface ErrorCapture {
  readonly code: string;
  readonly correlationId?: string;
  readonly jobId?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface ErrorReporterOptions {
  readonly configuredSecrets?: readonly string[];
  readonly dsn?: string;
  readonly environment: string;
  readonly release?: string;
  readonly revision?: string;
  readonly service: string;
}

export class ErrorReporter {
  readonly #configuredSecrets: readonly string[];
  readonly #enabled: boolean;
  readonly #release: string | undefined;
  readonly #revision: string | undefined;
  readonly #service: string;

  constructor(options: ErrorReporterOptions) {
    this.#configuredSecrets = options.configuredSecrets ?? [];
    this.#enabled = options.dsn !== undefined && options.dsn !== "";
    this.#release = options.release;
    this.#revision = options.revision;
    this.#service = options.service;
    if (this.#enabled) {
      init({
        dsn: options.dsn,
        environment: options.environment,
        release: options.release,
        sendDefaultPii: false,
      });
    }
  }

  capture(error: unknown, capture: ErrorCapture): string | undefined {
    if (!this.#enabled) return undefined;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const sanitized = new Error(errorName);
    sanitized.name = errorName;
    return captureException(sanitized, {
      tags: {
        code: capture.code,
        service: this.#service,
        ...(this.#release === undefined ? {} : { release: this.#release }),
        ...(this.#revision === undefined ? {} : { revision: this.#revision }),
      },
      extra: redactLogRecord(
        {
          correlationId: capture.correlationId,
          jobId: capture.jobId,
          ...capture.context,
        },
        this.#configuredSecrets,
      ) as Record<string, unknown>,
    });
  }

  async close(timeoutMs = 2_000): Promise<boolean> {
    return this.#enabled ? flush(timeoutMs) : true;
  }
}
