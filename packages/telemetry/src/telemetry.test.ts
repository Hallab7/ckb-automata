import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { AUTOMATA_METRIC_NAMES, AutomataMetrics } from "./metrics.ts";
import { CorrelatedLogger } from "./structured-logger.ts";
import { TelemetryRuntime } from "./tracing.ts";
import { createQueueTraceEnvelope, recordQueueState, traceQueueJob } from "./queue.ts";

const correlationId = "018f3f4e-7b51-7ab1-8ad4-3ac5fd07bb8c";
const jobId = `0x${"12".repeat(32)}`;

test("publishes every Section 18 metric with bounded labels", async () => {
  const metrics = new AutomataMetrics();
  metrics.indexerTipLagBlocks.set(2);
  metrics.jobsLiveTotal.set(4);
  metrics.jobsReadyTotal.set(1);
  metrics.attemptsTotal.inc({ policy: "recurring", outcome: "confirmed" });
  metrics.executionLatencyBlocks.observe(3);
  metrics.dryRunFailuresTotal.inc({ code: "SCRIPT_FAILURE" });
  metrics.queueDepth.set({ queue: "evaluate" }, 2);
  metrics.queueOldestSeconds.set({ queue: "evaluate" }, 7);
  metrics.reorgsTotal.inc();
  metrics.rpcErrorsTotal.inc({ endpoint: "rpc", method: "get_tip_header" });
  metrics.rewardsEarnedShannonsTotal.inc(100);
  metrics.webhookDeliveriesTotal.inc({ outcome: "delivered" });

  const rendered = await metrics.render();
  for (const name of AUTOMATA_METRIC_NAMES) assert.match(rendered, new RegExp(`\\b${name}`));
  assert.doesNotMatch(rendered, /https?:\/\//);
});

test("structured logs preserve correlation while redacting every secret surface", () => {
  const lines: string[] = [];
  const configuredSecret = "configured-secret-value";
  const logger = new CorrelatedLogger({
    configuredSecrets: [configuredSecret],
    context: () => ({ correlationId, jobId }),
    now: () => new Date("2026-09-23T00:00:00.000Z"),
    release: "0.1.0",
    revision: "abcdef0",
    service: "test-service",
    writer: (line) => lines.push(line),
  });

  logger.error("job.failed", `failure included ${configuredSecret}`, {
    authorization: "Bearer raw-session",
    ownerLockHash: `0x${"34".repeat(32)}`,
    signature: "0xprivate-proof",
  });

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal(record["correlationId"], correlationId);
  assert.equal(record["jobId"], jobId);
  assert.equal(record["authorization"], "[REDACTED]");
  assert.equal(record["signature"], "[REDACTED]");
  assert.match(String(record["message"]), /\[REDACTED\]/);
  assert.equal(record["ownerLockHash"], `0x${"34".repeat(32)}`);
  assert.doesNotMatch(lines[0] ?? "", /raw-session|private-proof|configured-secret-value/);
});

test("trace context follows one job across API, indexing, queue, executor, and confirmation", async () => {
  const exporter = new InMemorySpanExporter();
  const runtime = new TelemetryRuntime({
    environment: "test",
    exporter,
    release: "0.1.0",
    revision: "abcdef0",
    serviceName: "test-service",
    serviceVersion: "0.0.0",
  });
  const carrier = await runtime.withCorrelation({ correlationId, jobId }, async () =>
    runtime.withSpan("api.job.read", { "http.method": "GET" }, async () =>
      runtime.withSpan("indexer.job.discover", { "ckb.block_number": 42 }, async () =>
        runtime.inject(),
      ),
    ),
  );
  await runtime.extract(carrier, async () =>
    runtime.withSpan(
      "queue.evaluate.process",
      { "messaging.destination.name": "evaluate" },
      async () =>
        runtime.withSpan("executor.adapter.run", { "automata.policy": "recurring" }, async () =>
          runtime.withSpan("confirmation.track", { "ckb.confirmations": 2 }, async () => undefined),
        ),
    ),
  );
  await runtime.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.deepEqual(spans.map(({ name }) => name).toSorted(), [
    "api.job.read",
    "confirmation.track",
    "executor.adapter.run",
    "indexer.job.discover",
    "queue.evaluate.process",
  ]);
  assert.equal(new Set(spans.map((span) => span.spanContext().traceId)).size, 1);
  assert.ok(spans.every((span) => span.attributes["automata.correlation_id"] === correlationId));
  assert.ok(spans.every((span) => span.attributes["automata.job_id"] === jobId));
  assert.ok(spans.every((span) => span.resource.attributes["service.release"] === "0.1.0"));
  assert.ok(spans.every((span) => span.resource.attributes["service.revision"] === "abcdef0"));
  assert.match(carrier["traceparent"] ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(carrier["x-correlation-id"], correlationId);
  assert.equal(carrier["x-automata-job-id"], jobId);
  await runtime.shutdown();
});

test("trace failures retain stable codes without recording raw error messages", async () => {
  const exporter = new InMemorySpanExporter();
  const runtime = new TelemetryRuntime({
    environment: "test",
    exporter,
    serviceName: "test-service",
    serviceVersion: "0.0.0",
  });
  await assert.rejects(
    runtime.withSpan("rpc.failed", {}, async () => {
      const error = new Error("Bearer raw-session-token");
      Reflect.set(error, "code", "RPC_UNAVAILABLE");
      throw error;
    }),
  );
  await runtime.forceFlush();
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.attributes["error.code"], "RPC_UNAVAILABLE");
  const serialized = JSON.stringify(span?.events ?? []);
  assert.doesNotMatch(serialized, /raw-session-token/);
  await runtime.shutdown();
});

test("queue helpers propagate job context and publish bounded queue state", async () => {
  const exporter = new InMemorySpanExporter();
  const runtime = new TelemetryRuntime({
    environment: "test",
    exporter,
    serviceName: "test-service",
    serviceVersion: "0.0.0",
  });
  const carrier = runtime.withCorrelation({ correlationId, jobId }, () =>
    createQueueTraceEnvelope(runtime),
  );
  await traceQueueJob(runtime, "confirm", "process", carrier, async () => undefined);
  const metrics = new AutomataMetrics();
  recordQueueState(metrics, "confirm", 3, 12.5);

  await runtime.forceFlush();
  const [span] = exporter.getFinishedSpans();
  assert.equal(span?.name, "queue.confirm.process");
  assert.equal(span?.attributes["automata.correlation_id"], correlationId);
  assert.equal(span?.attributes["automata.job_id"], jobId);
  const rendered = await metrics.render();
  assert.match(rendered, /automata_queue_depth\{queue="confirm"\} 3/);
  assert.match(rendered, /automata_queue_oldest_seconds\{queue="confirm"\} 12\.5/);
  assert.throws(() => recordQueueState(metrics, "confirm", -1, 0));
  await runtime.shutdown();
});
