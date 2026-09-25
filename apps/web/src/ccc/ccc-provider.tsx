"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { ccc } from "@ckb-ccc/connector-react";

import {
  REVIEW_FEE_RATE_MAXIMUM,
  parseHash32,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import {
  AUTOMATA_CCC_IDENTITY,
  PREFERRED_CCC_NETWORKS,
  deriveWalletReadiness,
  isSupportedWalletSigner,
} from "./policy.ts";
import { assertCanonicalReviewWindow } from "./review-window.ts";
import { WalletSessionContext, type WalletSession } from "./session.tsx";

const clientGuardSymbol = Symbol.for("ckb-automata.ccc-client-guard");

function reviewedScript(value: ccc.Script): ScriptIdentity {
  if (value.hashType === "data2") {
    throw new Error("CCC returned a data2 script that is outside the reviewed transaction schema");
  }
  return {
    codeHash: parseHash32(value.codeHash),
    hashType: value.hashType,
    args: value.args,
  };
}

function reviewedTransaction(transaction: ccc.Transaction): UnsignedDeadlineTransaction {
  return {
    version: ccc.numToHex(transaction.version) as "0x0",
    cellDeps: transaction.cellDeps.map((dependency) => ({
      outPoint: {
        txHash: parseHash32(dependency.outPoint.txHash),
        index: ccc.numToHex(dependency.outPoint.index),
      },
      depType: dependency.depType,
    })),
    headerDeps: transaction.headerDeps.map(parseHash32),
    inputs: transaction.inputs.map((input) => ({
      since: ccc.numToHex(input.since),
      previousOutput: {
        txHash: parseHash32(input.previousOutput.txHash),
        index: ccc.numToHex(input.previousOutput.index),
      },
    })),
    outputs: transaction.outputs.map((output) => ({
      capacity: ccc.numToHex(output.capacity),
      lock: reviewedScript(output.lock),
      type: output.type === undefined ? null : reviewedScript(output.type),
    })),
    outputsData: [...transaction.outputsData],
    witnesses: [...transaction.witnesses],
  };
}

function cccTransactionLike(transaction: UnsignedDeadlineTransaction): ccc.TransactionLike {
  return {
    version: transaction.version,
    cellDeps: transaction.cellDeps.map((dependency) => ({
      outPoint: { ...dependency.outPoint },
      depType: dependency.depType,
    })),
    headerDeps: [...transaction.headerDeps],
    inputs: transaction.inputs.map((input) => ({
      since: input.since,
      previousOutput: { ...input.previousOutput },
    })),
    outputs: transaction.outputs.map((output) => ({
      capacity: output.capacity,
      lock: { ...output.lock },
      type: output.type === null ? null : { ...output.type },
    })),
    outputsData: [...transaction.outputsData],
    witnesses: [...transaction.witnesses],
  };
}

function cccTransaction(transaction: UnsignedDeadlineTransaction): ccc.Transaction {
  return ccc.Transaction.from(cccTransactionLike(transaction));
}

function installConnectorClientGuard(): void {
  const prototype = ccc.SignersController.prototype as ccc.SignersController &
    Record<symbol, unknown>;
  if (prototype[clientGuardSymbol]) return;

  const refresh = prototype.refresh;
  prototype.refresh = async function guardedRefresh(
    this: ccc.SignersController,
    client: ccc.Client,
    onUpdate: (wallets: ccc.WalletWithSigners[]) => void,
    configs?: {
      icon?: string;
      name?: string;
      preferredNetworks?: ccc.NetworkPreference[];
    },
  ): Promise<void> {
    // Lit may refresh once before React assigns the web component's required client property.
    if (client === undefined) return;
    await refresh.call(this, client, onUpdate, configs);
  };
  prototype[clientGuardSymbol] = true;
}

installConnectorClientGuard();

class AutomataSignersController extends ccc.SignersController {
  override getConfig(
    configs?: Readonly<{
      icon?: string;
      name?: string;
      preferredNetworks?: ccc.NetworkPreference[];
    }>,
  ) {
    return super.getConfig({
      ...configs,
      icon: AUTOMATA_CCC_IDENTITY.icon,
      name: AUTOMATA_CCC_IDENTITY.name,
      preferredNetworks: PREFERRED_CCC_NETWORKS.map(({ addressPrefix, network, signerType }) => ({
        addressPrefix,
        network,
        signerType: ccc.SignerType[signerType],
      })),
    });
  }

  protected override async addSigner(
    walletName: string,
    icon: string,
    signerInfo: ccc.SignerInfo,
    context: ccc.SignersControllerRefreshContext,
  ): Promise<void> {
    if (!isSupportedWalletSigner(walletName, signerInfo.signer.type)) return;
    await super.addSigner(walletName, icon, signerInfo, context);
  }
}

class FixtureSigner extends ccc.Signer {
  readonly #balance: bigint;
  readonly #storageKey: string;

  constructor(client: ccc.Client, storageKey: string, balance: bigint = ccc.Zero) {
    super(client);
    this.#balance = balance;
    this.#storageKey = storageKey;
  }

  get type(): ccc.SignerType {
    return ccc.SignerType.CKB;
  }

  get signType(): ccc.SignerSignType {
    return ccc.SignerSignType.Unknown;
  }

  async connect(): Promise<void> {
    window.localStorage.setItem(this.#storageKey, "true");
  }

  override async disconnect(): Promise<void> {
    window.localStorage.removeItem(this.#storageKey);
  }

  async isConnected(): Promise<boolean> {
    return window.localStorage.getItem(this.#storageKey) === "true";
  }

  async getInternalAddress(): Promise<string> {
    return "ckt1fixtureinternaladdress";
  }

  async getAddressObjs(): Promise<ccc.Address[]> {
    return [];
  }

  override async getRecommendedAddress(): Promise<string> {
    return "ckt1fixturetestnetaddress";
  }

  override async getBalance(): Promise<ccc.Num> {
    return this.#balance;
  }
}

class RejectedFixtureSigner extends FixtureSigner {
  override async connect(): Promise<void> {
    throw new Error("The wallet rejected the connection request.");
  }
}

class FixtureSignersController extends AutomataSignersController {
  override async addRealSigners(context: ccc.SignersControllerRefreshContext): Promise<void> {
    const fixtures = [
      {
        name: "Automata Zero Balance",
        signer: new FixtureSigner(context.client, "automata-wallet-zero-balance"),
      },
      {
        name: "Automata Rejected Request",
        signer: new RejectedFixtureSigner(context.client, "automata-wallet-rejected"),
      },
      {
        name: "Automata Missing Extension",
        signer: new ccc.SignerAlwaysError(
          context.client,
          ccc.SignerType.CKB,
          "Install or unlock the fixture wallet extension, then retry.",
        ),
      },
      {
        name: "Automata Wrong Network",
        signer: new FixtureSigner(new ccc.ClientPublicMainnet(), "automata-wallet-wrong-network"),
      },
    ] as const;
    for (const fixture of fixtures) {
      await this.addSigner(
        fixture.name,
        AUTOMATA_CCC_IDENTITY.icon,
        new ccc.SignerInfo("CKB fixture", fixture.signer),
        context,
      );
    }
  }

  override async addDummySigners(): Promise<void> {}
}

function WalletSessionBridge({ children }: Readonly<{ children: ReactNode }>) {
  const connector = ccc.useCcc();
  const signer = ccc.useSigner();
  const status = deriveWalletReadiness(
    connector.client.addressPrefix,
    signer?.client.addressPrefix,
    signer !== undefined,
    signer?.type,
    connector.wallet?.name,
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [details, setDetails] = useState<{
    readonly address?: string;
    readonly balanceShannons?: bigint;
    readonly ownerLockHash?: string;
    readonly signer?: ccc.Signer;
    readonly status: WalletSession["detailsStatus"];
  }>({ status: "idle" });

  useEffect(() => {
    if (signer === undefined || status !== "ready") return;
    let active = true;
    setDetails({ signer, status: "loading" });
    void Promise.allSettled([
      signer.getRecommendedAddress(),
      signer.getBalance(),
      signer.getRecommendedAddressObj(),
    ]).then(([addressResult, balanceResult, addressObjectResult]) => {
      if (!active) return;
      setDetails({
        ...(addressResult.status === "fulfilled" ? { address: addressResult.value } : {}),
        ...(balanceResult.status === "fulfilled" ? { balanceShannons: balanceResult.value } : {}),
        ...(addressObjectResult.status === "fulfilled"
          ? {
              ownerLockHash: ccc.hashCkb(addressObjectResult.value.script.toBytes()),
            }
          : {}),
        signer,
        status:
          addressResult.status === "fulfilled" && balanceResult.status === "fulfilled"
            ? "ready"
            : "error",
      });
    });
    return () => {
      active = false;
    };
  }, [refreshKey, signer, status]);

  const currentDetails = details.signer === signer ? details : { status: "loading" as const };
  const value = useMemo<WalletSession>(() => {
    const requireSigner = (): ccc.Signer => {
      if (signer === undefined || status !== "ready") {
        throw new Error("Connect a supported CKB testnet wallet before reviewing a transaction.");
      }
      return signer;
    };
    return {
      address: status === "ready" ? currentDetails.address : undefined,
      balanceShannons: status === "ready" ? currentDetails.balanceShannons : undefined,
      close: () => connector.close(),
      completeForReview: async (transaction) => {
        const currentSigner = requireSigner();
        const completed = cccTransaction(transaction);
        await completed.completeFeeBy(currentSigner, undefined, undefined, {
          maxFeeRate: REVIEW_FEE_RATE_MAXIMUM,
        });
        return Object.freeze({
          hash: completed.hash(),
          transaction: reviewedTransaction(completed),
        });
      },
      detailsStatus: status === "ready" ? currentDetails.status : "idle",
      disconnect: () => connector.disconnect(),
      getSignerGenesisHash: async () => {
        const genesis = await requireSigner().client.getHeaderByNumber(0);
        if (genesis === undefined) throw new Error("The wallet client could not resolve genesis.");
        return genesis.hash;
      },
      getSignerLockHashes: async () =>
        new Set(
          (await requireSigner().getAddressObjs()).map((address) =>
            ccc.hashCkb(address.script.toBytes()),
          ),
        ),
      getOwnerLock: async (expectedLockHash) => {
        const addresses = await requireSigner().getAddressObjs();
        const owner = addresses.find(
          (address) => ccc.hashCkb(address.script.toBytes()) === expectedLockHash,
        );
        if (owner === undefined) {
          throw new Error("The connected wallet is not the owner of this automation.");
        }
        return reviewedScript(owner.script);
      },
      isConnectorOpen: connector.isOpen,
      open: () => connector.open(),
      ownerLockHash: status === "ready" ? currentDetails.ownerLockHash : undefined,
      refreshDetails: () => setRefreshKey((current) => current + 1),
      resolveLock: async (addressValue) => {
        const address = await ccc.Address.fromString(
          addressValue.trim(),
          signer?.client ?? connector.client,
        );
        return reviewedScript(address.script);
      },
      resolveLockHash: async (addressValue) => {
        const address = await ccc.Address.fromString(
          addressValue.trim(),
          signer?.client ?? connector.client,
        );
        return ccc.hashCkb(address.script.toBytes());
      },
      resolveReviewInput: async (input) => {
        const currentSigner = requireSigner();
        const cell = await ccc.CellInput.from(input).getCell(currentSigner.client);
        return Object.freeze({
          capacity: cell.cellOutput.capacity,
          lockHash: ccc.hashCkb(cell.cellOutput.lock.toBytes()),
        });
      },
      resolveLiveReviewInput: async (input) => {
        const currentSigner = requireSigner();
        const cell = await currentSigner.client.getCellLive(input.previousOutput, true, true);
        if (cell === undefined) {
          throw new Error("A reviewed wallet input is no longer live. Build a fresh review.");
        }
        return Object.freeze({
          capacity: cell.cellOutput.capacity,
          lockHash: ccc.hashCkb(cell.cellOutput.lock.toBytes()),
        });
      },
      reviewLockHash: (scriptValue) => ccc.hashCkb(ccc.Script.from(scriptValue).toBytes()),
      selectDeadlinePledge: async () => {
        const currentSigner = requireSigner();
        for await (const cell of currentSigner.findCells(
          { scriptLenRange: [0, 1], outputDataLenRange: [0, 1] },
          true,
        )) {
          return Object.freeze({
            txHash: cell.outPoint.txHash,
            index: cell.outPoint.index.toString(),
          });
        }
        throw new Error(
          "The connected wallet has no plain CKB cell available for this automation.",
        );
      },
      signer,
      signSettingsMessage: async (message) => {
        const currentSigner = requireSigner();
        const address = await currentSigner.getRecommendedAddressObj();
        const ownerLock = reviewedScript(address.script);
        const ownerLockHash = ccc.hashCkb(address.script.toBytes());
        if (ownerLockHash !== currentDetails.ownerLockHash) {
          throw new Error("The connected wallet address changed. Reconnect before signing in.");
        }
        const signature = await currentSigner.signMessage(message);
        if (signature.signType !== ccc.SignerSignType.CkbSecp256k1) {
          throw new Error("This wallet cannot sign CKB settings authentication messages.");
        }
        return Object.freeze({
          ownerLock,
          signature: Object.freeze({
            identity: signature.identity,
            signature: signature.signature,
            signType: ccc.SignerSignType.CkbSecp256k1,
          }),
        });
      },
      signReviewedTransaction: async (transaction, expectedHash, snapshot) => {
        const currentSigner = requireSigner();
        const tip = await currentSigner.client.getTipHeader();
        const snapshotBlock = BigInt(snapshot.blockNumber);
        const canonicalHeader = await currentSigner.client.getHeaderByNumber(snapshotBlock);
        assertCanonicalReviewWindow(snapshot, tip.number, canonicalHeader?.hash);
        const unsigned = cccTransaction(transaction);
        if (unsigned.hash() !== expectedHash) {
          throw new Error("The transaction changed after review. Build a fresh review.");
        }
        for (const input of unsigned.inputs) {
          if (
            (await currentSigner.client.getCellLive(input.previousOutput, true, true)) === undefined
          ) {
            throw new Error("A reviewed wallet input is no longer live. Build a fresh review.");
          }
        }
        const signed = await currentSigner.signOnlyTransaction(cccTransactionLike(transaction));
        if (signed.hash() !== expectedHash) {
          throw new Error("The wallet changed the reviewed transaction while signing.");
        }
        return reviewedTransaction(signed);
      },
      status,
      submitSignedTransaction: async (transaction, expectedHash) => {
        const currentSigner = requireSigner();
        const signed = cccTransaction(transaction);
        if (signed.hash() !== expectedHash) {
          throw new Error("The signed transaction no longer matches the reviewed transaction.");
        }
        try {
          const submittedHash = await currentSigner.client.sendTransaction(
            cccTransactionLike(transaction),
          );
          if (submittedHash !== expectedHash) {
            throw new Error("The CKB node returned a different transaction hash.");
          }
          return submittedHash;
        } catch (error) {
          const observed = await currentSigner.client
            .getTransaction(expectedHash)
            .catch(() => undefined);
          if (observed !== undefined) return expectedHash;
          throw error;
        }
      },
      walletName: connector.wallet?.name,
    };
  }, [connector, currentDetails, signer, status]);
  return <WalletSessionContext.Provider value={value}>{children}</WalletSessionContext.Provider>;
}

export function CccProvider({ children }: Readonly<{ children: ReactNode }>) {
  const fixture = usePathname() === "/fixtures/wallet-provider";
  const client = useMemo(() => new ccc.ClientPublicTestnet(), []);
  const signersController = useMemo(
    () => (fixture ? new FixtureSignersController() : new AutomataSignersController()),
    [fixture],
  );
  return (
    <ccc.Provider
      connectorProps={{ "aria-label": "CKB wallet connector" }}
      defaultClient={client}
      icon={AUTOMATA_CCC_IDENTITY.icon}
      name={AUTOMATA_CCC_IDENTITY.name}
      signersController={signersController}
    >
      <WalletSessionBridge>{children}</WalletSessionBridge>
    </ccc.Provider>
  );
}
