import assert from "node:assert/strict";
import test from "node:test";

import { ValidationPipe, type INestApplication, type LoggerService } from "@nestjs/common";

import {
  API_GLOBAL_PREFIX,
  createApiApplication,
  parseApiBootstrapConfig,
  startApi,
} from "./bootstrap.ts";

const GENESIS_HASH = `0x${"1".repeat(64)}`;

function environment(overrides = {}) {
  return {
    AUTOMATA_PROFILE: "test",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: GENESIS_HASH,
    CKB_RPC_URL: "http://127.0.0.1:8114",
    CKB_INDEXER_URL: "http://127.0.0.1:8116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
    ...overrides,
  };
}

function fakeApplication() {
  const calls: {
    pipes: unknown[];
    prefixes: string[];
    interceptors: unknown[];
    shutdownHooks: number;
    listens: [number, string][];
  } = {
    pipes: [],
    prefixes: [],
    interceptors: [],
    shutdownHooks: 0,
    listens: [],
  };
  const app = {
    useGlobalPipes(...pipes: unknown[]) {
      calls.pipes.push(...pipes);
      return this;
    },
    useGlobalInterceptors(...interceptors: unknown[]) {
      calls.interceptors.push(...interceptors);
      return this;
    },
    setGlobalPrefix(prefix: string) {
      calls.prefixes.push(prefix);
      return this;
    },
    enableShutdownHooks() {
      calls.shutdownHooks += 1;
      return this;
    },
    async listen(port: number, host: string) {
      calls.listens.push([port, host]);
    },
  };
  return { app: app as unknown as INestApplication, calls };
}

const quietLogger = {
  log() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
} satisfies LoggerService;

test("invalid configuration prevents application creation and listener startup", async () => {
  let creations = 0;
  await assert.rejects(
    createApiApplication(
      { ...environment(), CKB_GENESIS_HASH: "invalid" },
      {
        createApplication: async () => {
          creations += 1;
          return fakeApplication().app;
        },
        logger: quietLogger,
      },
    ),
  );
  assert.equal(creations, 0);
  assert.throws(() => parseApiBootstrapConfig({ ...environment(), API_PORT: "70000" }));
});

test("bootstrap installs validation, versioning, shutdown hooks, and structured logging", async () => {
  const fixture = fakeApplication();
  let receivedLogger: LoggerService | undefined;
  const result = await createApiApplication(
    { ...environment(), API_HOST: "127.0.0.1", API_PORT: "4301" },
    {
      createApplication: async (logger) => {
        receivedLogger = logger;
        return fixture.app;
      },
    },
  );
  assert.ok(receivedLogger);
  assert.ok(receivedLogger);
  assert.notEqual(receivedLogger.constructor.name, "ConsoleLogger");
  assert.deepEqual(result.config, {
    environment: parseApiBootstrapConfig(environment()).environment,
    corsOrigins: ["http://127.0.0.1:3000"],
    host: "127.0.0.1",
    port: 4301,
    trustedProxies: [],
  });
  assert.deepEqual(fixture.calls.prefixes, [API_GLOBAL_PREFIX]);
  assert.equal(fixture.calls.shutdownHooks, 1);
  assert.equal(fixture.calls.pipes.length, 1);
  assert.equal(fixture.calls.interceptors.length, 1);
  assert.ok(fixture.calls.pipes[0] instanceof ValidationPipe);
  const validation = fixture.calls.pipes[0] as unknown as {
    readonly isTransformEnabled: boolean;
    readonly validatorOptions: Readonly<Record<string, unknown>>;
  };
  assert.equal(validation.isTransformEnabled, true);
  assert.deepEqual(validation.validatorOptions, {
    forbidUnknownValues: false,
    forbidNonWhitelisted: true,
    whitelist: true,
  });
});

test("bootstrap rejects wildcard origins and malformed trusted proxies", () => {
  assert.throws(() => parseApiBootstrapConfig({ ...environment(), API_CORS_ORIGINS: "*" }));
  assert.throws(() =>
    parseApiBootstrapConfig({ ...environment(), API_TRUSTED_PROXIES: "proxy.internal" }),
  );
});

test("start listens only after successful configuration", async () => {
  const fixture = fakeApplication();
  const result = await startApi(environment(), {
    createApplication: async () => fixture.app,
    logger: quietLogger,
  });
  assert.equal(result.app, fixture.app);
  assert.deepEqual(fixture.calls.listens, [[3001, "0.0.0.0"]]);
});

test("default application factory uses the pinned Fastify adapter", async () => {
  const result = await createApiApplication(environment(), { logger: quietLogger });
  try {
    assert.equal(result.app.getHttpAdapter().constructor.name, "FastifyAdapter");
    await result.app.init();
    const fastify = result.app.getHttpAdapter().getInstance() as {
      inject(input: { method: string; url: string }): Promise<{
        headers: Readonly<Record<string, string | string[] | undefined>>;
        statusCode: number;
        json(): unknown;
      }>;
    };
    const liveness = await fastify.inject({ method: "GET", url: "/v1/health/live" });
    assert.equal(liveness.statusCode, 200);
    assert.equal(liveness.headers["cache-control"], "no-store");
    assert.equal(liveness.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(liveness.json(), {
      status: "ok",
      service: "ckb-automata:api",
      uptimeSeconds: (liveness.json() as { uptimeSeconds: number }).uptimeSeconds,
    });
    const unversioned = await fastify.inject({ method: "GET", url: "/health/live" });
    assert.equal(unversioned.statusCode, 404);
    const readiness = await fastify.inject({ method: "GET", url: "/v1/health/ready" });
    assert.equal(readiness.statusCode, 503);
    assert.equal((readiness.json() as { status: string }).status, "not_ready");
  } finally {
    await result.app.close();
  }
});
