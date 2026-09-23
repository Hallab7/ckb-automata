"use client";

import { Copy, ExternalLink, LogOut, RefreshCw, ShieldAlert, WalletCards } from "lucide-react";

import { Button, IconButton } from "@ckb-automata/ui";

import { publishNotification } from "../shell/notification-center.tsx";
import { useWalletSession } from "./session.tsx";
import { ckbTestnetAddressUrl, formatCkbBalance, shortenCkbAddress } from "./wallet-display.ts";

function WalletGuidance({
  action,
  detail,
  title,
}: Readonly<{ action: "disconnect" | "open"; detail: string; title: string }>) {
  const session = useWalletSession();
  return (
    <div className="app-wallet-control app-wallet-control--warning">
      <div className="app-wallet-control__heading">
        <ShieldAlert aria-hidden="true" size={18} />
        <strong>{title}</strong>
      </div>
      <p>{detail}</p>
      <Button
        icon={
          action === "disconnect" ? (
            <LogOut aria-hidden="true" size={17} />
          ) : (
            <WalletCards aria-hidden="true" size={17} />
          )
        }
        onClick={action === "disconnect" ? session.disconnect : session.open}
        tone="secondary"
      >
        {action === "disconnect" ? "Disconnect wallet" : "Review wallet"}
      </Button>
    </div>
  );
}

export function WalletControl() {
  const session = useWalletSession();

  async function copyAddress() {
    if (session.address === undefined) return;
    try {
      await navigator.clipboard.writeText(session.address);
      publishNotification({
        id: "wallet-address-copied",
        message: "The complete CKB testnet address is on your clipboard.",
        title: "Address copied",
        tone: "success",
      });
    } catch {
      publishNotification({
        id: "wallet-address-copy-failed",
        message: "Clipboard access was denied. Open the explorer to inspect the address.",
        title: "Could not copy address",
        tone: "danger",
      });
    }
  }

  if (session.status === "disconnected") {
    return (
      <div className="app-wallet-control app-wallet-control--disconnected">
        <Button
          icon={<WalletCards aria-hidden="true" size={17} />}
          onClick={session.open}
          tone="secondary"
        >
          Connect wallet
        </Button>
        <strong>CKB Pudge Testnet only</strong>
        <p>Wallet unavailable? Install or unlock a supported CKB or BTC wallet, then retry.</p>
      </div>
    );
  }

  if (session.status === "wrong_network") {
    return (
      <WalletGuidance
        action="open"
        detail="Switch the wallet to CKB Pudge Testnet before reconnecting. Mainnet signing is blocked."
        title="Wrong wallet network"
      />
    );
  }

  if (session.status === "unsupported_wallet") {
    return (
      <WalletGuidance
        action="disconnect"
        detail="This signer family is not enabled. Select a supported CKB or BTC testnet wallet."
        title="Unsupported wallet"
      />
    );
  }

  const balance =
    session.balanceShannons === undefined
      ? session.detailsStatus === "error"
        ? "Balance unavailable"
        : "Loading balance..."
      : formatCkbBalance(session.balanceShannons);

  return (
    <div className="app-wallet-control">
      <div className="app-wallet-control__heading">
        <WalletCards aria-hidden="true" size={18} />
        <div>
          <span className="app-wallet-control__label">Wallet</span>
          <strong>{session.walletName ?? "Connected"}</strong>
        </div>
        <IconButton
          icon={<LogOut aria-hidden="true" size={17} />}
          label="Disconnect wallet"
          onClick={session.disconnect}
        />
      </div>
      <div className="app-wallet-control__address">
        <code title={session.address}>
          {session.address === undefined
            ? "Loading address..."
            : shortenCkbAddress(session.address)}
        </code>
        <IconButton
          disabled={session.address === undefined}
          icon={<Copy aria-hidden="true" size={16} />}
          label="Copy complete wallet address"
          onClick={() => void copyAddress()}
        />
        {session.address === undefined ? null : (
          <a
            aria-label="Open wallet address in the CKB testnet explorer"
            className="ui-icon-button ui-icon-button--ghost"
            href={ckbTestnetAddressUrl(session.address)}
            rel="noreferrer"
            target="_blank"
            title="Open in testnet explorer"
          >
            <ExternalLink aria-hidden="true" size={16} />
          </a>
        )}
      </div>
      <div className="app-wallet-control__footer">
        <span>{balance}</span>
        <strong>CKB Pudge Testnet</strong>
      </div>
      {session.detailsStatus === "error" ? (
        <Button
          icon={<RefreshCw aria-hidden="true" size={16} />}
          onClick={session.refreshDetails}
          tone="ghost"
        >
          Retry wallet details
        </Button>
      ) : null}
    </div>
  );
}
