const SHANNONS_PER_CKB = 100_000_000n;

export const CKB_TESTNET_EXPLORER_ORIGIN = "https://testnet.explorer.nervos.org";

export function shortenCkbAddress(address: string): string {
  return address.length <= 22 ? address : `${address.slice(0, 10)}...${address.slice(-8)}`;
}

export function formatCkbBalance(shannons: bigint): string {
  if (shannons < 0n) throw new RangeError("CKB balance cannot be negative");
  const whole = shannons / SHANNONS_PER_CKB;
  const fraction = (shannons % SHANNONS_PER_CKB).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} CKB`;
}

export function ckbTestnetAddressUrl(address: string): string {
  const url = new URL(`/address/${encodeURIComponent(address)}`, CKB_TESTNET_EXPLORER_ORIGIN);
  return url.toString();
}

export function ckbTestnetTransactionUrl(transactionHash: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new TypeError("transactionHash must be a lowercase 32-byte hash");
  }
  return new URL(`/transaction/${transactionHash}`, CKB_TESTNET_EXPLORER_ORIGIN).toString();
}

export function ckbTestnetBlockUrl(blockNumber: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(blockNumber)) {
    throw new TypeError("blockNumber must be canonical decimal");
  }
  return new URL(`/block/${blockNumber}`, CKB_TESTNET_EXPLORER_ORIGIN).toString();
}
