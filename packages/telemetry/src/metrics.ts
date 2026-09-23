import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  type CounterConfiguration,
  type GaugeConfiguration,
  type HistogramConfiguration,
} from "@prometheus-io/client";

export const AUTOMATA_METRIC_NAMES = Object.freeze([
  "automata_indexer_tip_lag_blocks",
  "automata_jobs_live_total",
  "automata_jobs_ready_total",
  "automata_attempts_total",
  "automata_execution_latency_blocks",
  "automata_dry_run_failures_total",
  "automata_queue_depth",
  "automata_queue_oldest_seconds",
  "automata_reorgs_total",
  "automata_rpc_errors_total",
  "automata_rewards_earned_shannons_total",
  "automata_webhook_deliveries_total",
] as const);

export interface AttemptMetricLabels {
  readonly policy: string;
  readonly outcome: string;
}

export interface QueueMetricLabels {
  readonly queue: string;
}

export interface RpcErrorMetricLabels {
  readonly endpoint: string;
  readonly method: string;
}

export interface WebhookMetricLabels {
  readonly outcome: string;
}

function counter<T extends string>(
  registry: Registry,
  config: CounterConfiguration<T>,
): Counter<T> {
  return new Counter({ ...config, registers: [registry] });
}

function gauge<T extends string>(registry: Registry, config: GaugeConfiguration<T>): Gauge<T> {
  return new Gauge({ ...config, registers: [registry] });
}

function histogram<T extends string>(
  registry: Registry,
  config: HistogramConfiguration<T>,
): Histogram<T> {
  return new Histogram({ ...config, registers: [registry] });
}

export class AutomataMetrics {
  readonly registry: Registry;
  readonly indexerTipLagBlocks: Gauge;
  readonly jobsLiveTotal: Gauge;
  readonly jobsReadyTotal: Gauge;
  readonly attemptsTotal: Counter<"policy" | "outcome">;
  readonly executionLatencyBlocks: Histogram;
  readonly dryRunFailuresTotal: Counter<"code">;
  readonly queueDepth: Gauge<"queue">;
  readonly queueOldestSeconds: Gauge<"queue">;
  readonly reorgsTotal: Counter;
  readonly rpcErrorsTotal: Counter<"endpoint" | "method">;
  readonly rewardsEarnedShannonsTotal: Counter;
  readonly webhookDeliveriesTotal: Counter<"outcome">;

  constructor(registry = new Registry()) {
    this.registry = registry;
    this.indexerTipLagBlocks = gauge(registry, {
      name: "automata_indexer_tip_lag_blocks",
      help: "Difference between the CKB tip and the indexed canonical checkpoint",
    });
    this.jobsLiveTotal = gauge(registry, {
      name: "automata_jobs_live_total",
      help: "Current number of canonical live jobs",
    });
    this.jobsReadyTotal = gauge(registry, {
      name: "automata_jobs_ready_total",
      help: "Current number of jobs eligible for execution",
    });
    this.attemptsTotal = counter(registry, {
      name: "automata_attempts_total",
      help: "Executor attempts by policy and outcome",
      labelNames: ["policy", "outcome"],
    });
    this.executionLatencyBlocks = histogram(registry, {
      name: "automata_execution_latency_blocks",
      help: "Blocks elapsed between eligibility and canonical execution",
      buckets: [0, 1, 2, 3, 5, 8, 13, 21, 34],
    });
    this.dryRunFailuresTotal = counter(registry, {
      name: "automata_dry_run_failures_total",
      help: "Dry-run failures by stable error code",
      labelNames: ["code"],
    });
    this.queueDepth = gauge(registry, {
      name: "automata_queue_depth",
      help: "Pending jobs by durable queue",
      labelNames: ["queue"],
    });
    this.queueOldestSeconds = gauge(registry, {
      name: "automata_queue_oldest_seconds",
      help: "Age of the oldest pending job by durable queue",
      labelNames: ["queue"],
    });
    this.reorgsTotal = counter(registry, {
      name: "automata_reorgs_total",
      help: "Canonical reorgs observed by the indexer",
    });
    this.rpcErrorsTotal = counter(registry, {
      name: "automata_rpc_errors_total",
      help: "CKB RPC failures by endpoint class and method",
      labelNames: ["endpoint", "method"],
    });
    this.rewardsEarnedShannonsTotal = counter(registry, {
      name: "automata_rewards_earned_shannons_total",
      help: "Executor rewards earned in shannons",
    });
    this.webhookDeliveriesTotal = counter(registry, {
      name: "automata_webhook_deliveries_total",
      help: "Webhook delivery attempts by outcome",
      labelNames: ["outcome"],
    });
  }

  contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
