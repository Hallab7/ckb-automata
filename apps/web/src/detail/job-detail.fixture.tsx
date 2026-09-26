"use client";

import { useState } from "react";
import { Ban, CirclePlus, LifeBuoy } from "lucide-react";

import type { ApiJob, ApiJobEvents } from "@ckb-automata/api-client";
import { Button, Dialog, InlineNotice, SelectField, TextField } from "@ckb-automata/ui";

import { JobDetailView } from "./job-detail-view.tsx";

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

type FixtureState =
  "deadline" | "recurring" | "cancelled" | "conflicted" | "dropped" | "reorged" | "unsupported";

function fixtureJob(state: FixtureState): ApiJob {
  const recurring = state !== "deadline";
  return {
    cancellationLockHash: HASH_A,
    funds: { capacity: "12500000000", executorReward: "100000000", remainingBudget: "500000000" },
    jobId: HASH_A,
    network: "ckb_testnet",
    ownerLockHash: HASH_B,
    payloadHash: HASH_A,
    policyScriptHash: HASH_B,
    protocol: { flags: 0, rawData: "0x01020304", version: (state === "unsupported" ? 2 : 1) as 1 },
    remainingRuns: recurring ? "4" : "0",
    sequence: recurring ? "2" : "0",
    source: {
      block: { hash: HASH_B, number: "15842800", transactionIndex: "1" },
      canonical: state !== "reorged",
      indexCheckpoint: { blockHash: HASH_A, blockNumber: "15842900" },
      outPoint: { index: "0", txHash: HASH_B },
    },
    state: state === "deadline" ? "spent" : state === "reorged" ? "orphaned" : "live",
    template: recurring ? "recurring" : "deadline",
    trigger: {
      kind: 0,
      metric: "block",
      notAfter: recurring ? "0" : "15842850",
      notBefore: "15842920",
      paramsHash: HASH_A,
    },
    updatedAt: "2026-09-24T10:00:00.000Z",
  };
}

function fixtureEvents(state: FixtureState): ApiJobEvents["items"] {
  const discovery = {
    eventId: "1",
    jobId: HASH_A,
    eventType: "job_discovered",
    category: "lifecycle",
    source: "indexed",
    confidence: state === "reorged" ? "reorged" : "confirmed",
    block: {
      number: "15842800",
      hash: HASH_B,
      transactionHash: HASH_B,
      transactionIndex: "1",
    },
    attempt: null,
    replacement: null,
    details: { outputIndex: "0", template: state === "deadline" ? "deadline" : "recurring" },
    occurredAt: "2026-09-24T09:00:00.000Z",
    recordedAt: "2026-09-24T09:00:01.000Z",
    orphanedAt: state === "reorged" ? "2026-09-24T10:00:00.000Z" : null,
  } as const satisfies ApiJobEvents["items"][number];
  if (state === "recurring" || state === "unsupported") return [discovery];

  const attemptState = state === "deadline" ? "confirmed" : state;
  const indexed = state === "deadline" || state === "conflicted" || state === "reorged";
  const receipt = ["deadline", "conflicted", "dropped"].includes(state)
    ? {
        id: "22222222-2222-4222-8222-222222222222",
        executorLockHash: HASH_B,
        keyId: `ckb-secp256k1:${"33".repeat(20)}`,
        signature: `0x${"44".repeat(64)}`,
        payload: { outcome: { state: attemptState }, software: { version: "0.0.0" } },
        createdAt: "2026-09-24T10:00:01.000Z",
      }
    : null;
  return [
    discovery,
    {
      eventId: "2",
      jobId: HASH_A,
      eventType: `transaction_${attemptState}`,
      category: "transaction",
      source: indexed ? "indexed" : "operational",
      confidence: state === "reorged" ? "reorged" : indexed ? "confirmed" : "observed",
      block: indexed
        ? {
            number: "15842880",
            hash: HASH_A,
            transactionHash: HASH_A,
            transactionIndex: "0",
          }
        : null,
      attempt: {
        id: ATTEMPT_ID,
        operation: state === "cancelled" ? "cancel" : "execute",
        state: attemptState,
        transactionHash: HASH_A,
        committedBlockNumber: indexed ? "15842880" : null,
        receipt,
      },
      replacement: null,
      details: { attemptId: ATTEMPT_ID, confirmations: indexed ? "3" : "0" },
      occurredAt: "2026-09-24T10:00:00.000Z",
      recordedAt: "2026-09-24T10:00:01.000Z",
      orphanedAt: state === "reorged" ? "2026-09-24T10:02:00.000Z" : null,
    },
  ] as ApiJobEvents["items"];
}

const states: readonly FixtureState[] = [
  "deadline",
  "recurring",
  "cancelled",
  "conflicted",
  "dropped",
  "reorged",
  "unsupported",
];

function FixtureDialog({ action }: Readonly<{ action: "cancel" | "recover" | "top_up" }>) {
  const topUp = action === "top_up";
  const recover = action === "recover";
  const label = topUp ? "Top up" : recover ? "Recover" : "Cancel";
  const icon = topUp ? (
    <CirclePlus aria-hidden="true" size={16} />
  ) : recover ? (
    <LifeBuoy aria-hidden="true" size={16} />
  ) : (
    <Ban aria-hidden="true" size={16} />
  );
  return (
    <Dialog
      description={
        topUp
          ? "Increase committed capacity or budget while preserving the existing policy."
          : recover
            ? "Recover a live job without relying on an executor."
            : "Return the remaining live funds and stop future execution."
      }
      footer={<Button tone={topUp ? "primary" : "danger"}>Approve {label.toLowerCase()}</Button>}
      title={`Review owner ${label.toLowerCase()}`}
      trigger={
        <Button icon={icon} tone={topUp ? "primary" : "secondary"}>
          {label}
        </Button>
      }
    >
      <div className="owner-action__dialog">
        {topUp ? (
          <div className="owner-action__amounts">
            <TextField defaultValue="100" label="Budget increase (CKB)" />
            <TextField defaultValue="0" label="Reward increase (CKB)" />
            <TextField defaultValue="161" label="Capacity increase (CKB)" />
          </div>
        ) : recover ? (
          <SelectField defaultValue="terminal_operational_failure" label="Recovery reason">
            <option value="terminal_operational_failure">Terminal operational failure</option>
            <option value="invalid_application_state">Invalid application state</option>
            <option value="unsupported_metadata">Unsupported metadata</option>
          </SelectField>
        ) : null}
        <InlineNotice title="Race protection" tone="warning">
          <p>
            The live job outpoint and chain tip are checked again immediately before the wallet
            opens.
          </p>
        </InlineNotice>
        <dl className="owner-action__facts">
          <div>
            <dt>Transaction hash</dt>
            <dd>
              <code>{HASH_A}</code>
            </dd>
          </div>
          <div>
            <dt>Live job outpoint</dt>
            <dd>
              <code>{HASH_B}:0</code>
            </dd>
          </div>
          <div>
            <dt>Snapshot</dt>
            <dd>Sep 24, 2026, 10:00 AM UTC</dd>
          </div>
          <div>
            <dt>Maximum fee</dt>
            <dd>0.000016 CKB</dd>
          </div>
        </dl>
      </div>
    </Dialog>
  );
}

function FixtureOwnerActions() {
  return (
    <section className="owner-actions" aria-labelledby="owner-actions-heading">
      <div>
        <h2 id="owner-actions-heading">Owner actions</h2>
        <p>Each action has a separate exact-transaction review.</p>
      </div>
      <div className="owner-actions__controls">
        <FixtureDialog action="top_up" />
        <FixtureDialog action="cancel" />
        <FixtureDialog action="recover" />
      </div>
    </section>
  );
}

export function JobDetailFixture() {
  const [state, setState] = useState<FixtureState>("conflicted");
  return (
    <div className="job-detail-fixture">
      <div className="job-detail-fixture__controls" aria-label="Job detail fixture state">
        {states.map((value) => (
          <button
            aria-pressed={state === value}
            key={value}
            onClick={() => setState(value)}
            type="button"
          >
            {value}
          </button>
        ))}
      </div>
      <JobDetailView
        events={fixtureEvents(state)}
        job={fixtureJob(state)}
        loadState="ready"
        ownerActions={<FixtureOwnerActions />}
        recipientAmount="10000000000"
      />
    </div>
  );
}
