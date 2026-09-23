"use client";

import { useAutomataSigner, useWalletSession } from "./session.tsx";
import { WalletControl } from "./wallet-control.tsx";
import { NotificationCenter } from "../shell/notification-center.tsx";

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
        <dt>Details</dt>
        <dd data-wallet-details={session.detailsStatus}>{session.detailsStatus}</dd>
        <dt>Balance</dt>
        <dd data-wallet-balance={session.balanceShannons?.toString() ?? "unavailable"}>
          {session.balanceShannons?.toString() ?? "Unavailable"}
        </dd>
      </dl>
      {session.status === "ready" ? (
        <button
          className="ui-button ui-button--secondary"
          data-fixture-wallet-action="disconnect"
          onClick={session.disconnect}
          type="button"
        >
          Disconnect
        </button>
      ) : (
        <button
          className="ui-button ui-button--primary"
          data-fixture-wallet-action="connect"
          onClick={session.open}
          type="button"
        >
          Connect wallet
        </button>
      )}
      <div className="wallet-control-fixture">
        <WalletControl />
      </div>
      <NotificationCenter />
    </main>
  );
}

export function WalletProviderFixture() {
  return <WalletProviderFixtureContent />;
}
