import { isIP } from "node:net";

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  RequestTimeoutException,
} from "@nestjs/common";
import { TimeoutError, type Observable, catchError, throwError, timeout } from "rxjs";

export const API_BODY_LIMIT_BYTES = 65_536;
export const API_REQUEST_RECEIVE_TIMEOUT_MS = 10_000;
export const API_DEFAULT_HANDLER_TIMEOUT_MS = 15_000;
export const API_AUTH_HANDLER_TIMEOUT_MS = 5_000;
export const API_TRANSACTION_HANDLER_TIMEOUT_MS = 12_000;
export const API_RATE_WINDOW_MS = 60_000;
export const API_RATE_LIMITS = Object.freeze({
  auth: 10,
  transaction: 20,
  mutation: 30,
  general: 120,
});
export const API_RATE_BUCKET_CAPACITY = 10_000;

type RateTier = keyof typeof API_RATE_LIMITS;

interface RateEntry {
  count: number;
  resetAt: number;
}

interface RequestLike {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly method: string;
  readonly raw: { readonly socket: { readonly remoteAddress?: string } };
  readonly url: string;
}

interface ReplyLike {
  readonly sent: boolean;
  code(status: number): ReplyLike;
  header(name: string, value: string | number): ReplyLike;
  send(payload?: unknown): unknown;
}

interface FastifyHookTarget {
  addHook(
    name: "onRequest",
    hook: (request: RequestLike, reply: ReplyLike) => Promise<unknown>,
  ): void;
  addHook(
    name: "onSend",
    hook: (request: RequestLike, reply: ReplyLike, payload: unknown) => Promise<unknown>,
  ): void;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
  readonly tier: RateTier;
}

export interface AbuseControlOptions {
  readonly allowedOrigins: readonly string[];
  readonly now?: () => number;
  readonly trustedProxies: readonly string[];
}

export interface ApiTimeoutInterceptorOptions {
  readonly timeoutFor?: (method: string, url: string) => number | null;
}

function normalizedAddress(value: string): string {
  const address = value.trim().toLowerCase();
  return address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) return value;
  return value.join(",");
}

export function resolveClientAddress(
  remoteAddress: string | undefined,
  forwardedFor: string | readonly string[] | undefined,
  trustedProxies: readonly string[],
): string {
  const remote = normalizedAddress(remoteAddress ?? "unknown");
  const trusted = new Set(trustedProxies.map(normalizedAddress));
  if (!trusted.has(remote)) return remote;
  const forwarded = headerValue(forwardedFor)?.split(",").map(normalizedAddress).filter(Boolean);
  if (
    forwarded === undefined ||
    forwarded.length === 0 ||
    forwarded.some((entry) => isIP(entry) === 0)
  ) {
    return remote;
  }
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const address = forwarded[index];
    if (address !== undefined && !trusted.has(address)) return address;
  }
  return forwarded[0] ?? remote;
}

function requestTier(method: string, url: string): RateTier {
  const path = url.split("?", 1)[0] ?? url;
  if (path.startsWith("/v1/auth/")) return "auth";
  if (path.startsWith("/v1/transactions/")) return "transaction";
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return "mutation";
  return "general";
}

export function endpointTimeoutMs(method: string, url: string): number | null {
  const path = url.split("?", 1)[0] ?? url;
  if (
    path === "/v1/events/stream" ||
    /^\/v1\/transactions\/0x[0-9a-f]{64}\/progress\/stream$/.test(path)
  ) {
    return null;
  }
  if (path.startsWith("/v1/auth/")) return API_AUTH_HANDLER_TIMEOUT_MS;
  if (path.startsWith("/v1/transactions/") && method === "POST") {
    return API_TRANSACTION_HANDLER_TIMEOUT_MS;
  }
  return API_DEFAULT_HANDLER_TIMEOUT_MS;
}

export class FixedWindowRateLimiter {
  readonly #entries = new Map<string, RateEntry>();
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #windowMs: number;
  #nextSweepAt = 0;

  constructor(
    options: {
      readonly maxEntries?: number;
      readonly now?: () => number;
      readonly windowMs?: number;
    } = {},
  ) {
    this.#maxEntries = options.maxEntries ?? API_RATE_BUCKET_CAPACITY;
    this.#now = options.now ?? Date.now;
    this.#windowMs = options.windowMs ?? API_RATE_WINDOW_MS;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new RangeError("rate bucket capacity must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#windowMs) || this.#windowMs < 1) {
      throw new RangeError("rate window must be a positive integer");
    }
  }

  consume(tier: RateTier, clientAddress: string): RateLimitResult {
    const now = this.#now();
    if (now >= this.#nextSweepAt) {
      for (const [key, entry] of this.#entries) {
        if (entry.resetAt <= now) this.#entries.delete(key);
      }
      this.#nextSweepAt = now + this.#windowMs;
    }
    const requestedKey = `${tier}:${clientAddress}`;
    const key =
      this.#entries.has(requestedKey) || this.#entries.size < this.#maxEntries
        ? requestedKey
        : `${tier}:overflow`;
    const limit = API_RATE_LIMITS[tier];
    const known = this.#entries.get(key);
    const entry =
      known === undefined || known.resetAt <= now
        ? { count: 0, resetAt: now + this.#windowMs }
        : known;
    entry.count += 1;
    this.#entries.set(key, entry);
    const allowed = entry.count <= limit;
    return Object.freeze({
      allowed,
      limit,
      remaining: Math.max(0, limit - entry.count),
      resetAt: entry.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)),
      tier,
    });
  }
}

function allowedOrigin(origin: string | undefined, allowlist: ReadonlySet<string>): boolean {
  return origin === undefined || allowlist.has(origin);
}

function applySecurityHeaders(reply: ReplyLike, strictTransport: boolean): void {
  reply
    .header("cache-control", "no-store")
    .header("content-security-policy", "default-src 'none'; frame-ancestors 'none'")
    .header("cross-origin-resource-policy", "same-site")
    .header("permissions-policy", "camera=(), geolocation=(), microphone=()")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY");
  if (strictTransport) {
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}

export function installFastifyAbuseControls(
  target: unknown,
  options: AbuseControlOptions & { readonly strictTransport: boolean },
): void {
  const fastify = target as FastifyHookTarget;
  const origins = new Set(options.allowedOrigins);
  const limiter = new FixedWindowRateLimiter(options.now === undefined ? {} : { now: options.now });
  fastify.addHook("onRequest", async (request, reply) => {
    const origin = headerValue(request.headers["origin"]);
    if (!allowedOrigin(origin, origins)) {
      return reply.code(403).send({
        status: "forbidden",
        code: "CORS_ORIGIN_DENIED",
        message: "request origin is not allowed",
      });
    }
    if (origin !== undefined) {
      reply.header("access-control-allow-origin", origin).header("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      const requestedMethod = headerValue(request.headers["access-control-request-method"]);
      if (
        requestedMethod === undefined ||
        !["GET", "HEAD", "POST", "PUT", "PATCH"].includes(requestedMethod.toUpperCase())
      ) {
        return reply.code(403).send();
      }
      return reply
        .header("access-control-allow-headers", "authorization, content-type, last-event-id")
        .header("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH")
        .header("access-control-max-age", "600")
        .code(204)
        .send();
    }
    const address = resolveClientAddress(
      request.raw.socket.remoteAddress,
      request.headers["x-forwarded-for"],
      options.trustedProxies,
    );
    const result = limiter.consume(requestTier(request.method, request.url), address);
    reply
      .header("x-ratelimit-limit", result.limit)
      .header("x-ratelimit-remaining", result.remaining)
      .header("x-ratelimit-reset", Math.ceil(result.resetAt / 1_000));
    if (!result.allowed) {
      return reply.header("retry-after", result.retryAfterSeconds).code(429).send({
        status: "rate_limited",
        code: "API_RATE_LIMITED",
        message: "request rate limit exceeded",
      });
    }
    return undefined;
  });
  fastify.addHook("onSend", async (_request, reply, payload) => {
    applySecurityHeaders(reply, options.strictTransport);
    return payload;
  });
}

export class ApiTimeoutInterceptor implements NestInterceptor {
  readonly #timeoutFor: (method: string, url: string) => number | null;

  constructor(options: ApiTimeoutInterceptorOptions = {}) {
    this.#timeoutFor = options.timeoutFor ?? endpointTimeoutMs;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<{ readonly method: string; readonly url: string }>();
    const milliseconds = this.#timeoutFor(request.method, request.url);
    if (milliseconds === null) return next.handle();
    return next.handle().pipe(
      timeout({ first: milliseconds }),
      catchError((error: unknown) =>
        error instanceof TimeoutError
          ? throwError(
              () =>
                new RequestTimeoutException({
                  status: "timeout",
                  code: "API_ENDPOINT_TIMEOUT",
                  message: "request processing exceeded its deadline",
                }),
            )
          : throwError(() => error),
      ),
    );
  }
}

Injectable()(ApiTimeoutInterceptor);
