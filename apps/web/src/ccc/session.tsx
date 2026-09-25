"use client";

import { createContext, useContext, type ReactNode } from "react";

import { Button, InlineNotice } from "@ckb-automata/ui";
import type { Signer } from "@ckb-ccc/connector-react";
import type { ScriptIdentity, UnsignedDeadlineTransaction } from "@ckb-automata/core";

import type { WalletReadiness } from "./policy.ts";

export interface WalletSession {
  readonly address: string | undefined;
  readonly balanceShannons: bigint | undefined;
  readonly close: () => void;
  readonly completeForReview: (transaction: UnsignedDeadlineTransaction) => Promise<{
    readonly hash: string;
    readonly transaction: UnsignedDeadlineTransaction;
  }>;
  readonly detailsStatus: "error" | "idle" | "loading" | "ready";
  readonly disconnect: () => void;
  readonly getSignerGenesisHash: () => Promise<string>;
  readonly getSignerLockHashes: () => Promise<ReadonlySet<string>>;
  readonly getOwnerLock: (expectedLockHash: string) => Promise<ScriptIdentity>;
  readonly isConnectorOpen: boolean;
  readonly open: () => void;
  readonly ownerLockHash: string | undefined;
  readonly refreshDetails: () => void;
  readonly resolveLock: (address: string) => Promise<ScriptIdentity>;
  readonly resolveLockHash: (address: string) => Promise<string>;
  readonly resolveReviewInput: (
    input: UnsignedDeadlineTransaction["inputs"][number],
  ) => Promise<{ readonly capacity: bigint; readonly lockHash: string }>;
  readonly resolveLiveReviewInput: (
    input: UnsignedDeadlineTransaction["inputs"][number],
  ) => Promise<{ readonly capacity: bigint; readonly lockHash: string }>;
  readonly reviewLockHash: (script: ScriptIdentity) => string;
  readonly selectDeadlinePledge: () => Promise<{
    readonly index: string;
    readonly txHash: string;
  }>;
  readonly signer: Signer | undefined;
  readonly signSettingsMessage: (message: string) => Promise<{
    readonly ownerLock: ScriptIdentity;
    readonly signature: {
      readonly identity: string;
      readonly signature: string;
      readonly signType: "CkbSecp256k1";
    };
  }>;
  readonly signReviewedTransaction: (
    transaction: UnsignedDeadlineTransaction,
    expectedHash: string,
    snapshot: {
      readonly blockHash: string;
      readonly blockNumber: string;
      readonly expiresAfterBlock?: string;
    },
  ) => Promise<UnsignedDeadlineTransaction>;
  readonly status: WalletReadiness;
  readonly submitSignedTransaction: (
    transaction: UnsignedDeadlineTransaction,
    expectedHash: string,
  ) => Promise<string>;
  readonly walletName: string | undefined;
}

export const WalletSessionContext = createContext<WalletSession | undefined>(undefined);

export function useWalletSession(): WalletSession {
  const session = useContext(WalletSessionContext);
  if (session === undefined) throw new Error("useWalletSession requires CccProvider");
  return session;
}

export function useAutomataSigner(): Signer | undefined {
  const session = useWalletSession();
  return session.status === "ready" ? session.signer : undefined;
}

function WrongNetworkNotice() {
  const session = useWalletSession();
  return (
    <InlineNotice title="Wrong wallet network" tone="danger">
      <p>Switch the wallet to CKB testnet before reviewing or signing a transaction.</p>
      <Button onClick={session.open} tone="secondary">
        Review wallet
      </Button>
    </InlineNotice>
  );
}

function UnsupportedWalletNotice() {
  const session = useWalletSession();
  return (
    <InlineNotice title="Unsupported wallet" tone="danger">
      <p>Disconnect this wallet and select MetaMask or a supported CKB or BTC testnet wallet.</p>
      <Button onClick={session.disconnect} tone="secondary">
        Disconnect wallet
      </Button>
    </InlineNotice>
  );
}

export function WalletNetworkNotice() {
  const session = useWalletSession();
  const notice =
    session.status === "wrong_network" ? (
      <WrongNetworkNotice />
    ) : session.status === "unsupported_wallet" ? (
      <UnsupportedWalletNotice />
    ) : null;
  return notice === null ? null : <div className="app-network-alert">{notice}</div>;
}

export function TestnetSignerGate({ children }: Readonly<{ children: ReactNode }>) {
  const session = useWalletSession();
  if (session.status === "wrong_network") return <WrongNetworkNotice />;
  if (session.status === "unsupported_wallet") return <UnsupportedWalletNotice />;
  if (session.status === "disconnected") {
    return (
      <InlineNotice title="Wallet connection required" tone="warning">
        <p>Connect a supported testnet wallet before continuing to transaction review.</p>
        <Button onClick={session.open} tone="secondary">
          Connect wallet
        </Button>
      </InlineNotice>
    );
  }
  return children;
}
