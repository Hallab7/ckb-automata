import {
  CONTRACT_CAPACITY,
  isAbsoluteBlockDeadline,
  parseBlockNumber,
  parseDeadlineCreationRequest,
  parseHash32,
} from "@ckb-automata/core";

import { ckbToShannons, shannonsToCkb } from "./ckb-amount.ts";
import type { SetupDraft, SetupErrors, SetupStepId } from "./setup-flow.ts";

const SYNTHETIC_PLEDGE_OUT_POINT = `0x${"11".repeat(32)}`;

export const DEADLINE_INITIAL_DRAFT: SetupDraft = Object.freeze({
  deadlineBlock: "",
  pledgeCkb: "",
  refundAddress: "",
  rewardCkb: "61",
  successAddress: "",
  targetCkb: "",
});

export interface DeadlineValidationContext {
  readonly ownerLockHash: string | undefined;
  readonly resolveLockHash: (address: string) => Promise<string>;
  readonly walletReady: boolean;
}

export function clientAcceptsDeadlineRequest(input: unknown): boolean {
  try {
    parseDeadlineCreationRequest(input);
    return true;
  } catch {
    return false;
  }
}

function required(
  draft: SetupDraft,
  name: string,
  message: string,
  errors: Record<string, string>,
) {
  const value = draft[name]?.trim();
  if (!value) errors[name] = message;
  return value ?? "";
}

function amount(
  draft: SetupDraft,
  name: string,
  label: string,
  minimum: bigint,
  errors: Record<string, string>,
): string | undefined {
  const value = required(draft, name, `Enter ${label}.`, errors);
  if (!value) return undefined;
  try {
    const parsed = BigInt(ckbToShannons(value));
    if (parsed < minimum) {
      errors[name] = `${label} must be at least ${shannonsToCkb(minimum)} CKB.`;
      return undefined;
    }
    return parsed.toString();
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : `Enter a valid ${label}.`;
    return undefined;
  }
}

async function address(
  draft: SetupDraft,
  name: string,
  label: string,
  context: DeadlineValidationContext,
  errors: Record<string, string>,
): Promise<string | undefined> {
  const value = required(draft, name, `Enter the ${label}.`, errors);
  if (!value) return undefined;
  try {
    return parseHash32(await context.resolveLockHash(value));
  } catch {
    errors[name] = `Enter a valid CKB testnet address for the ${label}.`;
    return undefined;
  }
}

export async function validateDeadlineStep(
  step: SetupStepId,
  draft: SetupDraft,
  context: DeadlineValidationContext,
): Promise<SetupErrors> {
  const errors: Record<string, string> = {};
  if (step === "details") {
    amount(draft, "pledgeCkb", "recipient amount", CONTRACT_CAPACITY.plainWalletCell, errors);
    amount(draft, "targetCkb", "minimum amount", 1n, errors);
    await Promise.all([
      address(draft, "successAddress", "recipient address", context, errors),
      address(draft, "refundAddress", "refund address", context, errors),
    ]);
  }

  if (step === "timing") {
    const value = required(draft, "deadlineBlock", "Enter the deadline block.", errors);
    if (value) {
      try {
        const block = parseBlockNumber(value);
        if (!isAbsoluteBlockDeadline(block)) throw new RangeError();
      } catch {
        errors["deadlineBlock"] = "Enter a non-zero absolute CKB block number.";
      }
    }
  }

  if (step === "funding") {
    const pledge = amount(
      draft,
      "pledgeCkb",
      "recipient amount",
      CONTRACT_CAPACITY.plainWalletCell,
      errors,
    );
    const target = amount(draft, "targetCkb", "minimum amount", 1n, errors);
    const reward = amount(
      draft,
      "rewardCkb",
      "automation service payment",
      CONTRACT_CAPACITY.plainWalletCell,
      errors,
    );
    let deadline: string | undefined;
    try {
      deadline = parseBlockNumber(draft["deadlineBlock"] ?? "").toString();
      if (!isAbsoluteBlockDeadline(parseBlockNumber(deadline))) deadline = undefined;
    } catch {
      deadline = undefined;
    }
    if (!context.walletReady || context.ownerLockHash === undefined) {
      errors["ownerAddress"] = "Connect a supported CKB testnet wallet for recovery authority.";
    }
    const [successLockHash, refundLockHash] = await Promise.all([
      address(draft, "successAddress", "recipient address", context, errors),
      address(draft, "refundAddress", "refund address", context, errors),
    ]);
    if (
      pledge !== undefined &&
      target !== undefined &&
      reward !== undefined &&
      deadline !== undefined &&
      successLockHash !== undefined &&
      refundLockHash !== undefined &&
      context.ownerLockHash !== undefined
    ) {
      try {
        parseDeadlineCreationRequest({
          pledges: [
            {
              outPoint: { txHash: SYNTHETIC_PLEDGE_OUT_POINT, index: "0" },
              refundLockHash,
              amount: pledge,
            },
          ],
          target,
          deadlineBlock: deadline,
          successLockHash,
          cancelLockHash: context.ownerLockHash,
          reward,
          creatorNonce: "0",
        });
      } catch {
        errors["rewardCkb"] = "These funding values cannot create a valid deadline automation.";
      }
    }
  }
  return Object.freeze(errors);
}
