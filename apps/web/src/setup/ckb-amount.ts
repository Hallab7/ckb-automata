import { parseShannons } from "@ckb-automata/core";

export const SHANNONS_PER_CKB = 100_000_000n;

export function ckbToShannons(value: string): string {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(value.trim());
  if (match === null) {
    throw new TypeError("Enter CKB with no more than 8 decimal places.");
  }
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  return parseShannons(whole * SHANNONS_PER_CKB + fraction).toString();
}

export function shannonsToCkb(value: bigint): string {
  const whole = value / SHANNONS_PER_CKB;
  const fraction = (value % SHANNONS_PER_CKB).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
