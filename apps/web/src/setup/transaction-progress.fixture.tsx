"use client";

import { useState } from "react";

import type { ApiTransactionProgress } from "@ckb-automata/api-client";

import { TransactionProgressPanel } from "./transaction-progress.tsx";
import {
  TRANSACTION_PROGRESS_STATES,
  type TransactionProgressState,
} from "./transaction-progress-model.ts";

const TRANSACTION_HASH = `0x${"52".repeat(32)}`;
const BLOCK_HASH = `0x${"73".repeat(32)}`;

function fixtureProgress(state: TransactionProgressState): ApiTransactionProgress {
  const included = state === "committed" || state === "confirmed" || state === "reorged";
  return {
    transactionHash: TRANSACTION_HASH,
    state,
    confirmations: state === "confirmed" ? "3" : state === "committed" ? "2" : "0",
    requiredConfirmations: 3,
    block: included ? { number: "15,842,901".replaceAll(",", ""), hash: BLOCK_HASH } : null,
    observedAt: "2026-09-24T10:01:00.000Z",
    reason: null,
  };
}

export function TransactionProgressFixture() {
  const [state, setState] = useState<TransactionProgressState>("committed");
  return (
    <main className="app-page" aria-labelledby="fixture-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <p className="setup-flow__eyebrow">CKB Pudge Testnet</p>
          <h1 id="fixture-title">Transaction progress fixture</h1>
        </div>
      </header>
      <div
        className="transaction-progress-fixture__controls"
        aria-label="Transaction progress state"
      >
        {TRANSACTION_PROGRESS_STATES.map((value) => (
          <button
            aria-pressed={state === value}
            className="ui-button ui-button--secondary"
            key={value}
            onClick={() => setState(value)}
            type="button"
          >
            {value}
          </button>
        ))}
      </div>
      <div className="setup-step">
        <TransactionProgressPanel persisted progress={fixtureProgress(state)} />
      </div>
    </main>
  );
}
