import {
  CONTRACT_CAPACITY,
  MAX_UINT32,
  calculateRecurringQuote,
  minimumPlainCellCapacity,
  parseBlockNumber,
  parseHash32,
  parseRecurringCreationRequest,
  parseRunCount,
  type ScriptIdentity,
} from "@ckb-automata/core";

import { ckbToShannons, shannonsToCkb } from "./ckb-amount.ts";
import type { SetupDraft, SetupErrors, SetupStepId } from "./setup-flow.ts";

const MAX_ABSOLUTE_BLOCK = (1n << 56n) - 1n;
const PREVIEW_FEE = Object.freeze({
  transactionBytes: Object.freeze({ minimum: "1", maximum: "1" }),
  feeRatePerKilobyte: Object.freeze({ minimum: "0", maximum: "0" }),
});

export const RECURRING_INITIAL_DRAFT: SetupDraft = Object.freeze({
  amountCkb: "",
  firstExecutionBlock: "",
  intervalBlocks: "",
  recipientAddress: "",
  rewardCkb: "61",
  runCount: "",
});

export interface RecurringValidationContext {
  readonly balanceShannons: bigint | undefined;
  readonly ownerLockHash: string | undefined;
  readonly resolveLock: (address: string) => Promise<ScriptIdentity>;
  readonly resolveLockHash: (address: string) => Promise<string>;
  readonly walletReady: boolean;
}

export interface RecurringFundingPreview {
  readonly amountPerRun: bigint;
  readonly payoutTotal: bigint;
  readonly rewardPerRun: bigint;
  readonly rewardTotal: bigint;
  readonly occupiedCapacity: bigint;
  readonly totalLocked: bigint;
  readonly totalLockedCkb: string;
}

export function clientAcceptsRecurringRequest(input: unknown): boolean {
  try {
    parseRecurringCreationRequest(input);
    return true;
  } catch {
    return false;
  }
}

function canonicalDecimal(value: string, name: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value.trim())) {
    throw new TypeError(`${name} must be a whole number without separators.`);
  }
  return BigInt(value);
}

function ckbAmount(value: string, label: string): bigint {
  const parsed = BigInt(ckbToShannons(value));
  if (parsed < CONTRACT_CAPACITY.plainWalletCell) {
    throw new RangeError(`${label} must be at least 61 CKB.`);
  }
  return parsed;
}

export function recurringFundingPreview(draft: SetupDraft): RecurringFundingPreview {
  const amountPerRun = ckbAmount(draft["amountCkb"] ?? "", "Payment per run");
  const rewardPerRun = ckbAmount(draft["rewardCkb"] ?? "", "Executor reward");
  const runs = parseRunCount(canonicalDecimal(draft["runCount"] ?? "", "Run count"));
  const quote = calculateRecurringQuote({
    amountPerExecution: amountPerRun,
    rewardPerExecution: rewardPerRun,
    executions: runs,
    creationFee: PREVIEW_FEE,
  });
  return Object.freeze({
    amountPerRun,
    payoutTotal: quote.applicationAmount.total,
    rewardPerRun,
    rewardTotal: quote.rewards.total,
    occupiedCapacity: quote.occupiedCapacity.jobCell,
    totalLocked: quote.maximumLockedTotal,
    totalLockedCkb: shannonsToCkb(quote.maximumLockedTotal),
  });
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

async function recipient(
  draft: SetupDraft,
  context: RecurringValidationContext,
  errors: Record<string, string>,
): Promise<{ readonly lockHash: string; readonly minimumCapacity: bigint } | undefined> {
  const value = required(draft, "recipientAddress", "Enter the payment recipient.", errors);
  if (!value) return undefined;
  try {
    const [lockHash, lock] = await Promise.all([
      context.resolveLockHash(value),
      context.resolveLock(value),
    ]);
    return Object.freeze({
      lockHash: parseHash32(lockHash),
      minimumCapacity: minimumPlainCellCapacity(lock),
    });
  } catch {
    errors["recipientAddress"] = "Enter a valid CKB testnet recipient address.";
    return undefined;
  }
}

function validateAmount(
  draft: SetupDraft,
  name: string,
  label: string,
  errors: Record<string, string>,
) {
  const value = required(draft, name, `Enter the ${label}.`, errors);
  if (!value) return undefined;
  try {
    return ckbAmount(value, label);
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : `Enter a valid ${label}.`;
    return undefined;
  }
}

function timingValues(draft: SetupDraft, errors: Record<string, string>) {
  let first: bigint | undefined;
  let interval: bigint | undefined;
  let runs: bigint | undefined;
  try {
    first = parseBlockNumber(
      canonicalDecimal(
        required(draft, "firstExecutionBlock", "Enter the first execution block.", errors),
        "First execution block",
      ),
    );
    if (first === 0n || first > MAX_ABSOLUTE_BLOCK) throw new RangeError();
  } catch {
    errors["firstExecutionBlock"] = "Enter a non-zero absolute CKB block number.";
  }
  try {
    interval = parseBlockNumber(
      canonicalDecimal(
        required(draft, "intervalBlocks", "Enter the interval.", errors),
        "Interval",
      ),
    );
    if (interval === 0n) throw new RangeError();
  } catch {
    errors["intervalBlocks"] = "Enter at least 1 block between payments.";
  }
  try {
    runs = parseRunCount(
      canonicalDecimal(required(draft, "runCount", "Enter the run count.", errors), "Run count"),
    );
    if (runs === 0n || runs > MAX_UINT32) throw new RangeError();
  } catch {
    errors["runCount"] = "Enter between 1 and 4,294,967,295 runs.";
  }
  if (first !== undefined && interval !== undefined && runs !== undefined) {
    const last = first + (runs - 1n) * interval;
    if (last > MAX_ABSOLUTE_BLOCK) {
      errors["runCount"] = "The final run exceeds the supported CKB block range.";
      runs = undefined;
    }
  }
  return { first, interval, runs };
}

export async function validateRecurringStep(
  step: SetupStepId,
  draft: SetupDraft,
  context: RecurringValidationContext,
): Promise<SetupErrors> {
  const errors: Record<string, string> = {};
  if (step === "details") {
    const resolvedRecipient = await recipient(draft, context, errors);
    const amount = validateAmount(draft, "amountCkb", "payment per run", errors);
    if (
      resolvedRecipient !== undefined &&
      amount !== undefined &&
      amount < resolvedRecipient.minimumCapacity
    ) {
      errors["amountCkb"] =
        `Payment per run must be at least ${shannonsToCkb(resolvedRecipient.minimumCapacity)} CKB for this recipient address.`;
    }
  }
  if (step === "timing") timingValues(draft, errors);
  if (step === "funding") {
    const amount = validateAmount(draft, "amountCkb", "payment per run", errors);
    const reward = validateAmount(draft, "rewardCkb", "executor reward", errors);
    const { first, interval, runs } = timingValues(draft, errors);
    const resolvedRecipient = await recipient(draft, context, errors);
    if (
      resolvedRecipient !== undefined &&
      amount !== undefined &&
      amount < resolvedRecipient.minimumCapacity
    ) {
      errors["amountCkb"] =
        `Payment per run must be at least ${shannonsToCkb(resolvedRecipient.minimumCapacity)} CKB for this recipient address.`;
    }
    if (!context.walletReady || context.ownerLockHash === undefined) {
      errors["ownerAddress"] = "Connect a supported CKB testnet wallet for funding and refunds.";
    }
    let preview: RecurringFundingPreview | undefined;
    try {
      preview = recurringFundingPreview(draft);
    } catch {
      errors["rewardCkb"] = "The complete schedule exceeds CKB funding limits.";
    }
    if (context.walletReady && context.balanceShannons === undefined) {
      errors["ownerAddress"] = "Wait for the connected wallet balance to finish loading.";
    } else if (
      preview !== undefined &&
      context.balanceShannons !== undefined &&
      context.balanceShannons < preview.totalLocked
    ) {
      errors["ownerAddress"] =
        `Wallet balance is below the ${preview.totalLockedCkb} CKB locked total.`;
    }
    if (
      amount !== undefined &&
      reward !== undefined &&
      first !== undefined &&
      interval !== undefined &&
      runs !== undefined &&
      resolvedRecipient !== undefined &&
      context.ownerLockHash !== undefined
    ) {
      try {
        parseRecurringCreationRequest({
          ownerLockHash: context.ownerLockHash,
          recipientLockHash: resolvedRecipient.lockHash,
          amount: amount.toString(),
          intervalBlocks: interval.toString(),
          firstNotBefore: first.toString(),
          totalRuns: runs.toString(),
          reward: reward.toString(),
          creatorNonce: "0",
        });
      } catch {
        errors["rewardCkb"] = "These values cannot create a valid recurring automation.";
      }
    }
  }
  return Object.freeze(errors);
}
