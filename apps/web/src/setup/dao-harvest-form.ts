import {
  DAO_HARVEST_JOB_OCCUPIED_CAPACITY,
  parseHash32,
  type ScriptIdentity,
} from "@ckb-automata/core";

import { ckbToShannons, shannonsToCkb } from "./ckb-amount.ts";
import { validateAutomationTitle } from "./automation-title.ts";
import type { SetupDraft, SetupErrors, SetupStepId } from "./setup-flow.ts";

export const DAO_HARVEST_MINIMUM_CKB = "210";
export const DAO_HARVEST_REWARD_PER_ACTION_CKB = "61";
export const DAO_HARVEST_ESTIMATED_NETWORK_FEE_CKB = "1";
export const DAO_HARVEST_MAX_CYCLES = 12;

export const DAO_HARVEST_INITIAL_DRAFT: SetupDraft = Object.freeze({
  cycleCount: "1",
  payoutAddress: "",
  principalCkb: "",
  recurrence: "once",
  title: "",
});

export interface DaoHarvestValidationContext {
  readonly balanceShannons: bigint | undefined;
  readonly ownerLockHash: string | undefined;
  readonly resolveLockHash: (address: string) => Promise<string>;
  readonly walletAddress: string | undefined;
  readonly walletReady: boolean;
}

export interface DaoHarvestFundingPreview {
  readonly actionCount: bigint;
  readonly charges: bigint;
  readonly chargesCkb: string;
  readonly cycleCount: number;
  readonly principal: bigint;
  readonly principalCkb: string;
  readonly recoverableReserve: bigint;
  readonly recoverableReserveCkb: string;
  readonly total: bigint;
  readonly totalCkb: string;
}

function amount(value: string): bigint {
  const shannons = BigInt(ckbToShannons(value));
  if (shannons < BigInt(ckbToShannons(DAO_HARVEST_MINIMUM_CKB))) {
    throw new RangeError(`Original amount must be at least ${DAO_HARVEST_MINIMUM_CKB} CKB.`);
  }
  return shannons;
}

export function daoHarvestCycleCount(draft: SetupDraft): number {
  if (draft["recurrence"] === "once") return 1;
  const value = draft["cycleCount"]?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(value)) throw new RangeError("Choose a whole number of harvests.");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 2 || count > DAO_HARVEST_MAX_CYCLES) {
    throw new RangeError(`Choose between 2 and ${DAO_HARVEST_MAX_CYCLES} harvests.`);
  }
  return count;
}

export function daoHarvestFundingPreview(draft: SetupDraft): DaoHarvestFundingPreview {
  const principal = amount(draft["principalCkb"] ?? "");
  const cycleCount = daoHarvestCycleCount(draft);
  const actionCount = BigInt(cycleCount * 2);
  const rewards = BigInt(ckbToShannons(DAO_HARVEST_REWARD_PER_ACTION_CKB)) * actionCount;
  const networkFee = BigInt(ckbToShannons(DAO_HARVEST_ESTIMATED_NETWORK_FEE_CKB));
  const recoverableReserve = DAO_HARVEST_JOB_OCCUPIED_CAPACITY;
  const charges = recoverableReserve + rewards + networkFee;
  const total = principal + charges;
  return Object.freeze({
    actionCount,
    charges,
    chargesCkb: shannonsToCkb(charges),
    cycleCount,
    principal,
    principalCkb: shannonsToCkb(principal),
    recoverableReserve,
    recoverableReserveCkb: shannonsToCkb(recoverableReserve),
    total,
    totalCkb: shannonsToCkb(total),
  });
}

function required(
  draft: SetupDraft,
  name: string,
  message: string,
  errors: Record<string, string>,
): string {
  const value = draft[name]?.trim() ?? "";
  if (!value) errors[name] = message;
  return value;
}

export async function validateDaoHarvestStep(
  step: SetupStepId,
  draft: SetupDraft,
  context: DaoHarvestValidationContext,
): Promise<SetupErrors> {
  if (step !== "details") return {};
  const errors: Record<string, string> = {};
  const titleError = validateAutomationTitle(draft);
  if (titleError !== undefined) errors["title"] = titleError;

  try {
    amount(required(draft, "principalCkb", "Enter the original DAO amount.", errors));
  } catch (error) {
    errors["principalCkb"] = error instanceof Error ? error.message : "Enter a valid CKB amount.";
  }

  const payout = required(
    draft,
    "payoutAddress",
    "Enter the address that receives compensation.",
    errors,
  );
  if (payout) {
    try {
      const payoutLockHash = parseHash32(await context.resolveLockHash(payout));
      if (
        context.ownerLockHash !== undefined &&
        payoutLockHash === parseHash32(context.ownerLockHash)
      ) {
        errors["payoutAddress"] = "Use an address different from the owner wallet.";
      }
    } catch {
      errors["payoutAddress"] = "Enter a valid CKB testnet address.";
    }
  }

  try {
    daoHarvestCycleCount(draft);
  } catch (error) {
    errors["cycleCount"] = error instanceof Error ? error.message : "Choose a valid harvest count.";
  }

  if (!context.walletReady || context.ownerLockHash === undefined) {
    errors["ownerAddress"] = "Connect a supported CKB testnet wallet.";
  } else if (context.balanceShannons === undefined) {
    errors["ownerAddress"] = "Wait for the wallet balance to finish loading.";
  } else {
    try {
      if (context.balanceShannons < daoHarvestFundingPreview(draft).total) {
        errors["ownerAddress"] =
          "This wallet does not have enough CKB for the deposit and charges.";
      }
    } catch {
      // Field-level validation above explains incomplete values.
    }
  }
  return errors;
}

export function daoHarvestSetupRequest(
  draft: SetupDraft,
  context: Pick<DaoHarvestValidationContext, "ownerLockHash"> & {
    readonly ownerLock: ScriptIdentity;
    readonly payoutLock: ScriptIdentity;
    readonly payoutLockHash: string;
  },
) {
  if (context.ownerLockHash === undefined) throw new Error("Connect the owner wallet first.");
  const preview = daoHarvestFundingPreview(draft);
  return Object.freeze({
    ownerLockHash: parseHash32(context.ownerLockHash),
    payoutLockHash: parseHash32(context.payoutLockHash),
    principal: preview.principal.toString(),
    totalCycles: preview.cycleCount,
    lockResolutions: Object.freeze([context.ownerLock, context.payoutLock]),
  });
}
