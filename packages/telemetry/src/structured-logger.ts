import { redactLogRecord } from "@ckb-automata/config";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type LogWriter = (line: string) => void;

export interface LogRecord {
  readonly event: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly service: string;
  readonly timestamp: string;
  readonly correlationId?: string;
  readonly jobId?: string;
  readonly release?: string;
  readonly revision?: string;
  readonly [key: string]: unknown;
}

export class CorrelatedLogger {
  readonly #configuredSecrets: readonly string[];
  readonly #release: string | undefined;
  readonly #revision: string | undefined;
  readonly #service: string;
  readonly #writer: LogWriter;
  readonly #now: () => Date;
  readonly #context:
    (() => { readonly correlationId?: string; readonly jobId?: string } | undefined) | undefined;

  constructor(options: {
    readonly configuredSecrets?: readonly string[];
    readonly context?: () =>
      { readonly correlationId?: string; readonly jobId?: string } | undefined;
    readonly now?: () => Date;
    readonly release?: string;
    readonly revision?: string;
    readonly service: string;
    readonly writer?: LogWriter;
  }) {
    this.#configuredSecrets = options.configuredSecrets ?? [];
    this.#context = options.context;
    this.#release = options.release;
    this.#revision = options.revision;
    this.#service = options.service;
    this.#writer = options.writer ?? ((line) => process.stdout.write(`${line}\n`));
    this.#now = options.now ?? (() => new Date());
  }

  write(
    level: LogLevel,
    event: string,
    message: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    if (!/^[a-z][a-z0-9_.-]{0,95}$/.test(event)) throw new TypeError("log event is invalid");
    const record = redactLogRecord(
      {
        timestamp: this.#now().toISOString(),
        level,
        service: this.#service,
        event,
        message,
        ...(this.#release === undefined ? {} : { release: this.#release }),
        ...(this.#revision === undefined ? {} : { revision: this.#revision }),
        ...this.#context?.(),
        ...fields,
      },
      this.#configuredSecrets,
    );
    this.#writer(JSON.stringify(record));
  }

  debug(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write("debug", event, message, fields);
  }

  info(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write("info", event, message, fields);
  }

  warn(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write("warn", event, message, fields);
  }

  error(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write("error", event, message, fields);
  }

  fatal(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.write("fatal", event, message, fields);
  }
}
