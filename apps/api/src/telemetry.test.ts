import assert from "node:assert/strict";
import test from "node:test";

import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";

import type { AutomataEnvironment } from "@ckb-automata/config";
import { isCorrelationId } from "@ckb-automata/telemetry";

import { ApiTelemetryInterceptor, BackendTelemetry } from "./telemetry.ts";

const requestedCorrelationId = "018f3f4e-7b51-7ab1-8ad4-3ac5fd07bb8c";
const jobId = `0x${"12".repeat(32)}`;

function environment(): AutomataEnvironment {
  return {
    AUTOMATA_PROFILE: "test",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: `0x${"1".repeat(64)}`,
    CKB_RPC_URL: "http://127.0.0.1:8114/",
    CKB_INDEXER_URL: "http://127.0.0.1:8116/",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379/",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

function httpContext(input: { readonly correlationId?: string; readonly url?: string }) {
  const responseHeaders: Record<string, string> = {};
  const request = {
    headers: {
      authorization: "Bearer raw-session-token",
      ...(input.correlationId === undefined ? {} : { "x-correlation-id": input.correlationId }),
    },
    method: "GET",
    params: { jobId },
    url: input.url ?? `/v1/jobs/${jobId}`,
  };
  const response = {
    statusCode: 200,
    header(name: string, value: string) {
      responseHeaders[name] = value;
    },
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, responseHeaders };
}

test("API instrumentation preserves accepted correlation and job identifiers", async () => {
  const lines: string[] = [];
  const telemetry = new BackendTelemetry(environment(), { writer: (line) => lines.push(line) });
  const interceptor = new ApiTelemetryInterceptor(telemetry);
  const fixture = httpContext({ correlationId: requestedCorrelationId });
  const handler = { handle: () => of({ ok: true }) } satisfies CallHandler;

  assert.deepEqual(await lastValueFrom(interceptor.intercept(fixture.context, handler)), {
    ok: true,
  });
  assert.equal(fixture.responseHeaders["x-correlation-id"], requestedCorrelationId);
  const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal(record["event"], "api.request.completed");
  assert.equal(record["correlationId"], requestedCorrelationId);
  assert.equal(record["jobId"], jobId);
  assert.doesNotMatch(lines.join("\n"), /raw-session-token|authorization/i);
  await telemetry.onModuleDestroy();
});

test("API instrumentation replaces invalid correlation IDs and sanitizes failures", async () => {
  const lines: string[] = [];
  const telemetry = new BackendTelemetry(environment(), { writer: (line) => lines.push(line) });
  const interceptor = new ApiTelemetryInterceptor(telemetry);
  const fixture = httpContext({ correlationId: "invalid" });
  const error = new Error("Bearer raw-session-token");
  Reflect.set(error, "code", "TEST_FAILURE");
  Reflect.set(error, "status", 503);
  const handler = { handle: () => throwError(() => error) } satisfies CallHandler;

  await assert.rejects(lastValueFrom(interceptor.intercept(fixture.context, handler)), error);
  const generated = fixture.responseHeaders["x-correlation-id"] ?? "";
  assert.ok(isCorrelationId(generated));
  assert.notEqual(generated, "invalid");
  const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal(record["event"], "api.request.failed");
  assert.equal(record["code"], "TEST_FAILURE");
  assert.equal(record["statusCode"], 503);
  assert.equal(record["correlationId"], generated);
  assert.doesNotMatch(lines.join("\n"), /raw-session-token|Bearer/);
  await telemetry.onModuleDestroy();
});
