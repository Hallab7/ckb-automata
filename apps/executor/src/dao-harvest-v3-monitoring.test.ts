import assert from "node:assert/strict";
import test from "node:test";

import { AutomataMetrics } from "@ckb-automata/telemetry";
import { parseHash32 } from "@ckb-automata/core";

import { DaoHarvestV3Monitoring } from "./dao-harvest-v3-monitoring.ts";
import type { DaoHarvestV3ScheduleRecord } from "./dao-harvest-v3-safety.ts";

const hash = (digit: string) => parseHash32(`0x${digit.repeat(64)}`);
const record: DaoHarvestV3ScheduleRecord = Object.freeze({
  jobId: hash("1"),
  sequence: "2",
  state: "deposited",
  cycleIndex: "1",
  totalCycles: "3",
  live: true,
  canonical: true,
  notBeforeSince: "0",
  prepareCutoffSince: "1",
  takeoverDelaySince: "1",
  endEpochSince: "0",
  preferredPrepareOperatorLockHash: hash("2"),
  creditedPrepareOperatorLockHash: null,
  fallbackPrepareOperatorLockHashes: [hash("3")],
});

test("V3 monitoring deduplicates actionable conditions and bounds labels", async () => {
  const metrics = new AutomataMetrics();
  const monitoring = new DaoHarvestV3Monitoring(metrics);
  const missed = Object.freeze({
    status: "unavailable" as const,
    jobId: record.jobId,
    sequence: "2",
    cycleIndex: "1",
    reason: "missed_prepare_window" as const,
  });
  monitoring.beginScan();
  monitoring.observe(record, missed);
  monitoring.observe(record, missed);
  monitoring.lowCompensation(record);
  monitoring.lowCompensation(record);
  monitoring.recordTransition("fallback_prepare", "failed");
  monitoring.finishScan();

  const rendered = await metrics.render();
  assert.match(rendered, /automata_dao_harvest_missed_windows_total 1/);
  assert.match(rendered, /automata_dao_harvest_recovery_required_total 1/);
  assert.match(rendered, /automata_dao_harvest_low_compensation_total 1/);
  assert.match(
    rendered,
    /automata_dao_harvest_transitions_total\{operation="prepare",outcome="failed"\} 1/,
  );
  assert.match(rendered, /automata_dao_harvest_next_action_seconds\{state="deposited"\} -301/);
  assert.doesNotMatch(rendered, new RegExp(record.jobId));
});

test("V3 monitoring reports the earliest action and allows a later sequence to alert", async () => {
  const metrics = new AutomataMetrics();
  const monitoring = new DaoHarvestV3Monitoring(metrics);
  monitoring.beginScan();
  monitoring.observe(record, {
    status: "waiting",
    operation: "preferred_prepare",
    jobId: record.jobId,
    sequence: "2",
    cycleIndex: "1",
    notBefore: "1",
    delayMs: 20_000,
    reason: "early",
  });
  monitoring.observe(
    { ...record, jobId: hash("4") },
    {
      status: "waiting",
      operation: "fallback_prepare",
      jobId: hash("4"),
      sequence: "2",
      cycleIndex: "1",
      notBefore: "1",
      delayMs: 5_000,
      reason: "preferred_window",
    },
  );
  monitoring.finishScan();
  assert.match(
    await metrics.render(),
    /automata_dao_harvest_next_action_seconds\{state="deposited"\} 5/,
  );
});
