"use client";

import { useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { ccc } from "@ckb-ccc/connector-react";

import {
  AUTOMATA_CCC_IDENTITY,
  PREFERRED_CCC_NETWORKS,
  deriveWalletReadiness,
  isSupportedSignerType,
} from "./policy.ts";
import { WalletSessionContext, type WalletSession } from "./session.tsx";

const clientGuardSymbol = Symbol.for("ckb-automata.ccc-client-guard");

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
    if (!isSupportedSignerType(signerInfo.signer.type)) return;
    await super.addSigner(walletName, icon, signerInfo, context);
  }
}

const FIXTURE_CONNECTED_KEY = "automata-wallet-provider-fixture-connected";

class FixtureSigner extends ccc.Signer {
  get type(): ccc.SignerType {
    return ccc.SignerType.CKB;
  }

  get signType(): ccc.SignerSignType {
    return ccc.SignerSignType.Unknown;
  }

  async connect(): Promise<void> {
    window.localStorage.setItem(FIXTURE_CONNECTED_KEY, "true");
  }

  override async disconnect(): Promise<void> {
    window.localStorage.removeItem(FIXTURE_CONNECTED_KEY);
  }

  async isConnected(): Promise<boolean> {
    return window.localStorage.getItem(FIXTURE_CONNECTED_KEY) === "true";
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
    return ccc.Zero;
  }
}

class FixtureSignersController extends AutomataSignersController {
  override async addRealSigners(context: ccc.SignersControllerRefreshContext): Promise<void> {
    await this.addSigner(
      "Automata Fixture Wallet",
      AUTOMATA_CCC_IDENTITY.icon,
      new ccc.SignerInfo("CKB fixture", new FixtureSigner(context.client)),
      context,
    );
  }

  override async addDummySigners(): Promise<void> {}
}

function WalletSessionBridge({ children }: Readonly<{ children: ReactNode }>) {
  const connector = ccc.useCcc();
  const signer = ccc.useSigner();
  const value = useMemo<WalletSession>(() => {
    const status = deriveWalletReadiness(
      connector.client.addressPrefix,
      signer?.client.addressPrefix,
      signer !== undefined,
      signer?.type,
    );
    return {
      close: () => connector.close(),
      disconnect: () => connector.disconnect(),
      isConnectorOpen: connector.isOpen,
      open: () => connector.open(),
      signer,
      status,
      walletName: connector.wallet?.name,
    };
  }, [connector, signer]);
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
      signersController={signersController}
    >
      <WalletSessionBridge>{children}</WalletSessionBridge>
    </ccc.Provider>
  );
}
