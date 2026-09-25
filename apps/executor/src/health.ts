import { createServer, type Server } from "node:http";

import type { ExecutorRuntime } from "./runtime.ts";

export interface ExecutorHealthServer {
  readonly port: number;
  close(): Promise<void>;
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startExecutorHealthServer(
  runtime: ExecutorRuntime,
  port: number,
): Promise<ExecutorHealthServer> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("executor health port must be an integer between 1 and 65535");
  }
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { status: "method_not_allowed" });
      return;
    }
    if (request.url === "/health/live") {
      json(response, 200, {
        status: "ok",
        service: "ckb-automata:executor",
        instanceId: runtime.readiness().instanceId,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
      });
      return;
    }
    if (request.url === "/health/ready") {
      const report = runtime.readiness();
      json(response, report.status === "ready" ? 200 : 503, report);
      return;
    }
    json(response, 404, { status: "not_found" });
  });
  await listen(server, port);
  let closed = false;
  return Object.freeze({
    port,
    async close() {
      if (closed) return;
      closed = true;
      await close(server);
    },
  });
}
