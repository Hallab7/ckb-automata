export const AUTOMATA_CCC_IDENTITY = Object.freeze({
  icon: "/automata-mark.svg",
  name: "CKB Automata",
});

export const EXPECTED_CKB_ADDRESS_PREFIX = "ckt" as const;

export const SUPPORTED_CCC_SIGNER_TYPES = Object.freeze(["CKB", "BTC"] as const);

export const SUPPORTED_EVM_WALLETS = Object.freeze(["MetaMask"] as const);

export const PREFERRED_CCC_NETWORKS = Object.freeze([
  Object.freeze({
    addressPrefix: EXPECTED_CKB_ADDRESS_PREFIX,
    network: "btcTestnet",
    signerType: "BTC",
  }),
]);

export type WalletReadiness = "disconnected" | "ready" | "unsupported_wallet" | "wrong_network";

export function isSupportedSignerType(value: string): boolean {
  return SUPPORTED_CCC_SIGNER_TYPES.some((supported) => supported === value);
}

export function isSupportedWalletSigner(walletName: string, signerType: string): boolean {
  if (isSupportedSignerType(signerType)) return true;
  if (signerType !== "EVM") return false;
  const normalizedName = walletName.trim().toLocaleLowerCase("en-US");
  return SUPPORTED_EVM_WALLETS.some(
    (supported) => supported.toLocaleLowerCase("en-US") === normalizedName,
  );
}

export function deriveWalletReadiness(
  clientAddressPrefix: string,
  signerAddressPrefix: string | undefined,
  hasSigner: boolean,
  signerType?: string,
  walletName?: string,
): WalletReadiness {
  if (
    clientAddressPrefix !== EXPECTED_CKB_ADDRESS_PREFIX ||
    (hasSigner && signerAddressPrefix !== EXPECTED_CKB_ADDRESS_PREFIX)
  ) {
    return "wrong_network";
  }
  if (hasSigner && !isSupportedWalletSigner(walletName ?? "", signerType ?? "")) {
    return "unsupported_wallet";
  }
  return hasSigner ? "ready" : "disconnected";
}
