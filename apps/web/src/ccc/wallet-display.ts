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
