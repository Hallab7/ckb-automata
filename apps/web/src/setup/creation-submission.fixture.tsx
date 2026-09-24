"use client";

import { useState } from "react";

import { InlineNotice } from "@ckb-automata/ui";

import { ApprovalPrompt } from "./creation-submission.tsx";

const TRANSACTION_HASH = `0x${"52".repeat(32)}`;
type WalletOutcome = "approved" | "closed" | "rejected";

const outcomeLabels: Readonly<Record<WalletOutcome, string>> = {
  approved: "Approve",
  closed: "Close request",
  rejected: "Reject",
};

export function CreationSubmissionFixture() {
  const [outcome, setOutcome] = useState<WalletOutcome>("approved");
  const [result, setResult] = useState<"idle" | "submitted" | "stopped">("idle");

  const selectOutcome = (next: WalletOutcome) => {
    setOutcome(next);
    setResult("idle");
  };

  return (
    <main className="app-page" aria-labelledby="fixture-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <p className="setup-flow__eyebrow">CKB Pudge Testnet</p>
          <h1 id="fixture-title">Wallet approval fixture</h1>
        </div>
      </header>
      <div className="transaction-progress-fixture__controls" aria-label="Wallet outcome">
        {(Object.keys(outcomeLabels) as WalletOutcome[]).map((value) => (
          <button
            aria-pressed={outcome === value}
            className="ui-button ui-button--secondary"
            key={value}
            onClick={() => selectOutcome(value)}
            type="button"
          >
            {outcomeLabels[value]}
          </button>
        ))}
      </div>
      <div className="setup-step">
        {result === "submitted" ? (
          <InlineNotice title="Transaction submitted" tone="success">
            <p>The deterministic wallet approved the exact reviewed transaction.</p>
          </InlineNotice>
        ) : null}
        <ApprovalPrompt
          {...(result === "stopped"
            ? {
                error:
                  outcome === "closed"
                    ? "The wallet request was closed. No transaction was submitted."
                    : "The wallet request was rejected. No transaction was submitted.",
              }
            : {})}
          network="ckb_testnet"
          onConnect={() => undefined}
          onSubmit={() => setResult(outcome === "approved" ? "submitted" : "stopped")}
          ready
          submitting={false}
          transactionHash={TRANSACTION_HASH}
          walletName="CKB test wallet"
        />
      </div>
    </main>
  );
}
