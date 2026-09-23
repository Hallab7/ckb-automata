import assert from "node:assert/strict";
import test from "node:test";

import { RequestTimeoutException, type ExecutionContext, type LoggerService } from "@nestjs/common";
import { NEVER, firstValueFrom } from "rxjs";

import {
  API_AUTH_HANDLER_TIMEOUT_MS,
  API_DEFAULT_HANDLER_TIMEOUT_MS,
  API_RATE_LIMITS,
  API_TRANSACTION_HANDLER_TIMEOUT_MS,
  ApiTimeoutInterceptor,
  FixedWindowRateLimiter,
  endpointTimeoutMs,
  resolveClientAddress,
} from "./abuse-controls.ts";
import { createApiApplication } from "./bootstrap.ts";

const quietLogger: LoggerService = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

function environment(overrides: Readonly<Record<string, string>> = {}) {
  return {
    AUTOMATA_PROFILE: "test",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: `0x${"1".repeat(64)}`,
    CKB_RPC_URL: "http://127.0.0.1:8114",
    CKB_INDEXER_URL: "http://127.0.0.1:8116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "https://app.example.test",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
    ...overrides,
  };
}

test("client identity trusts forwarding chains only from allowlisted peers", () => {
  assert.equal(resolveClientAddress("198.51.100.10", "203.0.113.7", []), "198.51.100.10");
  assert.equal(resolveClientAddress("10.0.0.10", "203.0.113.7", ["10.0.0.10"]), "203.0.113.7");
  assert.equal(
    resolveClientAddress("10.0.0.10", "192.0.2.9, 198.51.100.8, 10.0.0.11", [
      "10.0.0.10",
      "10.0.0.11",
    ]),
    "198.51.100.8",
  );
  assert.equal(resolveClientAddress("10.0.0.10", "not-an-ip", ["10.0.0.10"]), "10.0.0.10");
});

test("rate windows reject the boundary request and reset without unbounded keys", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({ maxEntries: 2, now: () => now, windowMs: 100 });
  for (let request = 0; request < API_RATE_LIMITS.auth; request += 1) {
    assert.equal(limiter.consume("auth", "198.51.100.1").allowed, true);
  }
  const rejected = limiter.consume("auth", "198.51.100.1");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.remaining, 0);
  assert.equal(limiter.consume("general", "198.51.100.2").allowed, true);
  assert.equal(limiter.consume("general", "198.51.100.3").allowed, true);
  now += 100;
  assert.equal(limiter.consume("auth", "198.51.100.1").allowed, true);
});

test("handler deadlines separate auth and transaction work and exempt event streams", () => {
  assert.equal(endpointTimeoutMs("POST", "/v1/auth/challenge"), API_AUTH_HANDLER_TIMEOUT_MS);
  assert.equal(
    endpointTimeoutMs("POST", "/v1/transactions/create-deadline-job"),
    API_TRANSACTION_HANDLER_TIMEOUT_MS,
  );
  assert.equal(endpointTimeoutMs("GET", "/v1/jobs"), API_DEFAULT_HANDLER_TIMEOUT_MS);
  assert.equal(endpointTimeoutMs("GET", "/v1/events/stream?jobId=value"), null);
});

test("handler deadline emits a stable timeout response", async () => {
  const interceptor = new ApiTimeoutInterceptor({ timeoutFor: () => 5 });
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ method: "GET", url: "/v1/jobs" }) }),
  } as unknown as ExecutionContext;

  await assert.rejects(
    firstValueFrom(interceptor.intercept(context, { handle: () => NEVER })),
    (error: unknown) => {
      assert.ok(error instanceof RequestTimeoutException);
      assert.deepEqual(error.getResponse(), {
        status: "timeout",
        code: "API_ENDPOINT_TIMEOUT",
        message: "request processing exceeded its deadline",
      });
      return true;
    },
  );
});

test("Fastify enforces body, origin, header, direct, and proxied boundaries", async () => {
  const result = await createApiApplication(
    environment({
      API_CORS_ORIGINS: "https://ops.example.test",
      API_TRUSTED_PROXIES: "10.0.0.10",
    }),
    { logger: quietLogger },
  );
  try {
    await result.app.init();
    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: {
        headers?: Readonly<Record<string, string>>;
        method: string;
        payload?: unknown;
        remoteAddress?: string;
        url: string;
      }): Promise<{
        headers: Readonly<Record<string, string | string[] | undefined>>;
        json(): unknown;
        statusCode: number;
      }>;
    };

    const denied = await fastify.inject({
      headers: { origin: "https://evil.example.test" },
      method: "GET",
      url: "/v1/health/live",
    });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(denied.json(), {
      status: "forbidden",
      code: "CORS_ORIGIN_DENIED",
      message: "request origin is not allowed",
    });

    const allowed = await fastify.inject({
      headers: { origin: "https://ops.example.test" },
      method: "GET",
      url: "/v1/health/live",
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], "https://ops.example.test");
    assert.equal(
      allowed.headers["content-security-policy"],
      "default-src 'none'; frame-ancestors 'none'",
    );

    const preflight = await fastify.inject({
      headers: {
        origin: "https://app.example.test",
        "access-control-request-method": "POST",
      },
      method: "OPTIONS",
      url: "/v1/auth/challenge",
    });
    assert.equal(preflight.statusCode, 204);
    assert.match(String(preflight.headers["access-control-allow-methods"]), /POST/);

    const oversized = await fastify.inject({
      method: "POST",
      payload: { ownerLockHash: "x".repeat(70_000) },
      remoteAddress: "198.51.100.100",
      url: "/v1/auth/challenge",
    });
    assert.equal(oversized.statusCode, 413);

    const paginationOverflow = await fastify.inject({
      method: "GET",
      remoteAddress: "198.51.100.101",
      url: "/v1/jobs?limit=101",
    });
    assert.equal(paginationOverflow.statusCode, 400);
    const unsupportedQuery = await fastify.inject({
      method: "GET",
      remoteAddress: "198.51.100.102",
      url: "/v1/jobs?unexpected=value",
    });
    assert.equal(unsupportedQuery.statusCode, 400);

    for (let request = 0; request <= API_RATE_LIMITS.auth; request += 1) {
      const response = await fastify.inject({
        headers: { "x-forwarded-for": `203.0.113.${request + 1}` },
        method: "POST",
        payload: {},
        remoteAddress: "198.51.100.20",
        url: "/v1/auth/challenge",
      });
      assert.equal(response.statusCode === 429, request === API_RATE_LIMITS.auth);
    }

    for (let request = 0; request <= API_RATE_LIMITS.auth; request += 1) {
      const response = await fastify.inject({
        headers: { "x-forwarded-for": `203.0.113.${request + 20}` },
        method: "POST",
        payload: {},
        remoteAddress: "10.0.0.10",
        url: "/v1/auth/challenge",
      });
      assert.notEqual(response.statusCode, 429);
    }

    for (let request = 0; request <= API_RATE_LIMITS.transaction; request += 1) {
      const response = await fastify.inject({
        method: "POST",
        payload: {},
        remoteAddress: "198.51.100.30",
        url: "/v1/transactions/create-deadline-job",
      });
      assert.equal(response.statusCode === 429, request === API_RATE_LIMITS.transaction);
      if (response.statusCode === 429) {
        assert.equal((response.json() as { code: string }).code, "API_RATE_LIMITED");
        assert.ok(Number(response.headers["retry-after"]) >= 1);
      }
    }
  } finally {
    await result.app.close();
  }
});
