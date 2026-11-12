import type { AutomataMetrics, DaoHarvestNextActionMetricLabels } from "@ckb-automata/telemetry";

import type {
  DaoHarvestV3Operation,
  DaoHarvestV3ScheduleDecision,
  DaoHarvestV3ScheduleRecord,
} from "./dao-harvest-v3-safety.ts";

type State = DaoHarvestNextActionMetricLabels["state"];
type Outcome = "confirmed" | "failed" | "reorged" | "conflicted";

function key(record: DaoHarvestV3ScheduleRecord): string {
  return `${record.jobId}:${record.sequence}`;
}

function transition(operation: DaoHarvestV3Operation): "prepare" | "roll" {
  return operation.endsWith("prepare") ? "prepare" : "roll";
}

export class DaoHarvestV3Monitoring {
  readonly #metrics: AutomataMetrics;
  readonly #reportedMisses = new Set<string>();
  readonly #reportedRecovery = new Set<string>();
  readonly #reportedLowCompensation = new Set<string>();
  readonly #next = new Map<State, number>();
  readonly #active = new Set<string>();

  constructor(metrics: AutomataMetrics) {
    this.#metrics = metrics;
  }

  beginScan(): void {
    this.#next.clear();
    this.#active.clear();
  }

  observe(record: DaoHarvestV3ScheduleRecord, decision: DaoHarvestV3ScheduleDecision): void {
    const recordKey = key(record);
    this.#active.add(recordKey);
    const state: State =
      record.state === "withdrawing" && decision.status === "ready" ? "claim_ready" : record.state;
    const seconds =
      decision.status === "waiting"
        ? decision.delayMs / 1_000
        : decision.status === "unavailable" && decision.reason === "missed_prepare_window"
          ? -301
          : 0;
    this.#next.set(state, Math.min(this.#next.get(state) ?? Number.POSITIVE_INFINITY, seconds));

    if (decision.status === "unavailable" && decision.reason === "missed_prepare_window") {
      if (!this.#reportedMisses.has(recordKey)) {
        this.#reportedMisses.add(recordKey);
        this.#metrics.daoHarvestMissedWindowsTotal.inc();
      }
      this.#recovery(recordKey);
    }
    if (
      decision.status === "terminal" &&
      (decision.reason === "cycle_limit" || decision.reason === "end_epoch_reached")
    ) {
      this.#recovery(recordKey);
    }
  }

  lowCompensation(record: DaoHarvestV3ScheduleRecord): void {
    const recordKey = key(record);
    if (this.#reportedLowCompensation.has(recordKey)) return;
    this.#reportedLowCompensation.add(recordKey);
    this.#metrics.daoHarvestLowCompensationTotal.inc();
  }

  recordTransition(operation: DaoHarvestV3Operation, outcome: Outcome): void {
    this.#metrics.daoHarvestTransitionsTotal.inc({ operation: transition(operation), outcome });
  }

  finishScan(): void {
    for (const state of ["deposited", "withdrawing", "claim_ready"] as const) {
      this.#metrics.daoHarvestNextActionSeconds.set(
        { state },
        this.#next.get(state) ?? Number.POSITIVE_INFINITY,
      );
    }
    for (const reported of [
      this.#reportedMisses,
      this.#reportedRecovery,
      this.#reportedLowCompensation,
    ]) {
      for (const recordKey of reported) {
        if (!this.#active.has(recordKey)) reported.delete(recordKey);
      }
    }
  }

  #recovery(recordKey: string): void {
    if (this.#reportedRecovery.has(recordKey)) return;
    this.#reportedRecovery.add(recordKey);
    this.#metrics.daoHarvestRecoveryRequiredTotal.inc();
  }
}
