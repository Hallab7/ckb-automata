"use client";

import { useAutomataSigner, useWalletSession } from "./session.tsx";

function WalletProviderFixtureContent() {
  const session = useWalletSession();
  const signer = useAutomataSigner();
  return (
    <main className="ui-story">
      <header className="ui-story__header">
        <div>
          <p className="ui-story__eyebrow">Provider fixture</p>
          <h1>Wallet session</h1>
          <p>CKB testnet connection lifecycle and signer availability.</p>
        </div>
      </header>
      <dl>
        <dt>Status</dt>
        <dd data-wallet-status={session.status}>{session.status}</dd>
        <dt>Signer</dt>
        <dd data-signer-ready={signer === undefined ? "false" : "true"}>
          {signer === undefined ? "Unavailable" : "Available"}
        </dd>
      </dl>
      {session.status === "ready" ? (
        <button
          className="ui-button ui-button--secondary"
          onClick={session.disconnect}
          type="button"
        >
          Disconnect
        </button>
      ) : (
        <button className="ui-button ui-button--primary" onClick={session.open} type="button">
          Connect wallet
        </button>
      )}
    </main>
  );
}

export function WalletProviderFixture() {
  return <WalletProviderFixtureContent />;
}
