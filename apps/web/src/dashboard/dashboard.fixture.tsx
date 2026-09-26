"use client";

import { useState } from "react";

import type { ApiJobList } from "@ckb-automata/api-client";

import {
  AutomationDashboardView,
  type DashboardLoadState,
  type DashboardMode,
} from "./dashboard-view.tsx";
import type { DashboardJob } from "./dashboard-model.ts";

const CHECKPOINT_BLOCK = "120";

function fixtureJob(
  seed: string,
  state: DashboardJob["state"],
  overrides: Partial<DashboardJob>,
): DashboardJob {
  const byte = seed.repeat(64).slice(0, 64);
  return {
    cancellationLockHash: `0x${"11".repeat(32)}`,
    funds: { capacity: "12500000000", executorReward: "100000000", remainingBudget: "500000000" },
    jobId: `0x${byte}`,
    network: "testnet",
    ownerLockHash: `0x${"22".repeat(32)}`,
    payloadHash: `0x${"33".repeat(32)}`,
    policyScriptHash: `0x${"44".repeat(32)}`,
    protocol: { flags: 0, rawData: "0x", version: 1 },
    remainingRuns: "4",
    sequence: seed,
    source: {
      block: { hash: `0x${"55".repeat(32)}`, number: "100", transactionIndex: "0" },
      canonical: state !== "orphaned",
      indexCheckpoint: { blockHash: `0x${"66".repeat(32)}`, blockNumber: CHECKPOINT_BLOCK },
      outPoint: { index: "0", txHash: `0x${"77".repeat(32)}` },
    },
    state,
    template: Number(seed) % 2 === 0 ? "deadline" : "recurring",
    trigger: {
      kind: 0,
      metric: "block",
      notAfter: "200",
      notBefore: "140",
      paramsHash: `0x${"88".repeat(32)}`,
    },
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  } as ApiJobList["items"][number];
}

const FIXTURE_JOBS = [
  fixtureJob("1", "live", {}),
  fixtureJob("2", "live", {
    trigger: {
      kind: 0,
      metric: "block",
      notAfter: "200",
      notBefore: "110",
      paramsHash: `0x${"88".repeat(32)}`,
    },
  }),
  fixtureJob("3", "live", {
    funds: { capacity: "12500000000", executorReward: "100000000", remainingBudget: "0" },
  }),
  fixtureJob("4", "live", {
    trigger: {
      kind: 0,
      metric: "block",
      notAfter: "115",
      notBefore: "90",
      paramsHash: `0x${"88".repeat(32)}`,
    },
  }),
  fixtureJob("5", "spent", { remainingRuns: "0" }),
  fixtureJob("6", "orphaned", {}),
] as const;

export function AutomationDashboardFixture() {
  const [fixtureState, setFixtureState] = useState<DashboardLoadState | "empty">("ready");
  const [mode, setMode] = useState<DashboardMode>("public");
  const loadState = fixtureState === "empty" ? "ready" : fixtureState;
  const items = fixtureState === "ready" ? FIXTURE_JOBS : [];
  return (
    <div className="dashboard-fixture">
      <div
        aria-label="Dashboard fixture state"
        className="dashboard-fixture__controls"
        role="group"
      >
        {(["ready", "loading", "empty", "owner_required", "error"] as const).map((state) => (
          <button
            aria-pressed={fixtureState === state}
            key={state}
            onClick={() => setFixtureState(state)}
            type="button"
          >
            {state.replace("_", " ")}
          </button>
        ))}
      </div>
      <AutomationDashboardView
        checkpointAt="2026-09-23T00:00:00.000Z"
        checkpointBlock={fixtureState === "ready" ? CHECKPOINT_BLOCK : undefined}
        error={loadState === "error" ? "Fixture API outage" : undefined}
        hasNextPage={loadState === "ready"}
        items={items}
        loadState={loadState}
        mode={mode}
        recipientAmounts={Object.fromEntries(
          items.map((item) => [item.jobId, { perExecution: "10000000000", total: "40000000000" }]),
        )}
        onConnect={() => setFixtureState("ready")}
        onLoadNext={() => undefined}
        onModeChange={setMode}
        onRetry={() => setFixtureState("ready")}
        onStateChange={() => undefined}
        onTemplateChange={() => undefined}
        stateFilter=""
        templateFilter=""
      />
    </div>
  );
}
