"use client";

import { ApprovalPrompt } from "./creation-submission.tsx";

const TRANSACTION_HASH = `0x${"52".repeat(32)}`;

export function CreationSubmissionFixture() {
  return (
    <main className="app-page" aria-labelledby="fixture-title">
      <header className="app-page-header">
        <div className="app-page-header__copy">
          <p className="setup-flow__eyebrow">CKB Pudge Testnet</p>
          <h1 id="fixture-title">Wallet approval fixture</h1>
        </div>
      </header>
      <div className="setup-step">
        <ApprovalPrompt
          network="ckb_testnet"
          onConnect={() => undefined}
          onSubmit={() => undefined}
          ready
          submitting={false}
          transactionHash={TRANSACTION_HASH}
          walletName="CKB test wallet"
        />
      </div>
    </main>
  );
}
