import {
  MAX_UINT64,
  parseRunCount,
  parseShannons,
  type IntegerInput,
  type RunCount,
  type Shannons,
} from "./chain-values.ts";
import { CONTRACT_CAPACITY } from "./contract-costs.ts";

export const REVIEW_TRANSACTION_MAXIMUM_BYTES = 4_096n;
export const REVIEW_FEE_RATE_MAXIMUM = 100_000n;

export interface FeeRangeInput {
  readonly transactionBytes: {
    readonly minimum: IntegerInput;
    readonly maximum: IntegerInput;
  };
  readonly feeRatePerKilobyte: {
    readonly minimum: IntegerInput;
    readonly maximum: IntegerInput;
  };
}

export interface EstimatedFeeRange {
  readonly minimum: Shannons;
  readonly maximum: Shannons;
}

export interface QuoteAmounts {
  readonly occupiedCapacity: {
    readonly jobCell: Shannons;
    readonly applicationCell: Shannons;
    readonly total: Shannons;
  };
  readonly applicationAmount: {
    readonly perExecution: Shannons;
    readonly total: Shannons;
  };
  readonly rewards: {
    readonly perExecution: Shannons;
    readonly total: Shannons;
  };
  readonly remainingBudget: Shannons;
  readonly residualRefund: Shannons;
  readonly retainedTerminalCapacity: Shannons;
  readonly estimatedFee: EstimatedFeeRange;
  readonly maximumLockedTotal: Shannons;
  readonly maximumOwnerFunding: Shannons;
}

export interface RecurringQuote extends QuoteAmounts {
  readonly kind: "recurring";
  readonly executions: RunCount;
}

export interface DeadlineQuote extends QuoteAmounts {
  readonly kind: "deadline";
  readonly executions: RunCount;
}

export interface RecurringQuoteInput {
  readonly amountPerExecution: IntegerInput;
  readonly rewardPerExecution: IntegerInput;
  readonly executions: IntegerInput;
  readonly creationFee: FeeRangeInput;
}

export interface DeadlineQuoteInput {
  readonly pledgedAmount: IntegerInput;
  readonly reward: IntegerInput;
  readonly creationFee: FeeRangeInput;
}

function parseQuoteInteger(value: IntegerInput, name: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (
    typeof value === "string" &&
    (/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) || /^(?:0|[1-9][0-9]*)$/.test(value))
  ) {
    parsed = BigInt(value);
  } else {
    throw new TypeError(`${name} must be a canonical decimal or lowercase hexadecimal integer`);
  }
  if (parsed < 0n || parsed > MAX_UINT64) {
    throw new RangeError(`${name} must fit uint64`);
  }
  return parsed;
}

function checkedShannons(value: bigint, name: string): Shannons {
  try {
    return parseShannons(value);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new RangeError(`${name} exceeds uint64 capacity`);
    }
    throw error;
  }
}

function requirePlainOutputMinimum(value: Shannons, name: string): void {
  if (value < CONTRACT_CAPACITY.plainWalletCell) {
    throw new RangeError(
      `${name} must fund the measured plain output minimum of ${CONTRACT_CAPACITY.plainWalletCell}`,
    );
  }
}

function freezeQuote<T extends QuoteAmounts>(quote: T): T {
  Object.freeze(quote.occupiedCapacity);
  Object.freeze(quote.applicationAmount);
  Object.freeze(quote.rewards);
  Object.freeze(quote.estimatedFee);
  return Object.freeze(quote);
}

function calculateEstimatedFee(bytes: bigint, rate: bigint, name: string): Shannons {
  return checkedShannons((bytes * rate + 999n) / 1_000n, name);
}

export function estimateTransactionFeeRange(input: FeeRangeInput): EstimatedFeeRange {
  const minimumBytes = parseQuoteInteger(
    input.transactionBytes.minimum,
    "minimum transaction bytes",
  );
  const maximumBytes = parseQuoteInteger(
    input.transactionBytes.maximum,
    "maximum transaction bytes",
  );
  const minimumRate = parseQuoteInteger(input.feeRatePerKilobyte.minimum, "minimum fee rate");
  const maximumRate = parseQuoteInteger(input.feeRatePerKilobyte.maximum, "maximum fee rate");
  if (minimumBytes === 0n || maximumBytes < minimumBytes) {
    throw new RangeError("transaction byte range must be positive and ordered");
  }
  if (maximumRate < minimumRate) {
    throw new RangeError("fee-rate range must be ordered");
  }

  return Object.freeze({
    minimum: calculateEstimatedFee(minimumBytes, minimumRate, "minimum fee"),
    maximum: calculateEstimatedFee(maximumBytes, maximumRate, "maximum fee"),
  });
}

export function calculateRecurringQuote(input: RecurringQuoteInput): RecurringQuote {
  const amount = parseShannons(input.amountPerExecution);
  const reward = parseShannons(input.rewardPerExecution);
  const executions = parseRunCount(input.executions);
  if (executions === 0n) {
    throw new RangeError("executions must be greater than zero");
  }
  requirePlainOutputMinimum(amount, "amountPerExecution");
  requirePlainOutputMinimum(reward, "rewardPerExecution");

  const applicationTotal = checkedShannons(amount * executions, "application total");
  const rewardTotal = checkedShannons(reward * executions, "reward total");
  const remainingBudget = checkedShannons(
    applicationTotal + rewardTotal,
    "recurring remaining budget",
  );
  const maximumLockedTotal = checkedShannons(
    CONTRACT_CAPACITY.jobCellV1 + remainingBudget,
    "recurring locked total",
  );
  const estimatedFee = estimateTransactionFeeRange(input.creationFee);

  return freezeQuote({
    kind: "recurring",
    executions,
    occupiedCapacity: {
      jobCell: CONTRACT_CAPACITY.jobCellV1,
      applicationCell: parseShannons(0n),
      total: CONTRACT_CAPACITY.jobCellV1,
    },
    applicationAmount: { perExecution: amount, total: applicationTotal },
    rewards: { perExecution: reward, total: rewardTotal },
    remainingBudget,
    residualRefund: CONTRACT_CAPACITY.jobCellV1,
    retainedTerminalCapacity: parseShannons(0n),
    estimatedFee,
    maximumLockedTotal,
    maximumOwnerFunding: checkedShannons(
      maximumLockedTotal + estimatedFee.maximum,
      "recurring owner funding",
    ),
  });
}

export function calculateDeadlineQuote(input: DeadlineQuoteInput): DeadlineQuote {
  const pledged = parseShannons(input.pledgedAmount);
  const reward = parseShannons(input.reward);
  requirePlainOutputMinimum(pledged, "pledgedAmount");
  requirePlainOutputMinimum(reward, "reward");

  const jobCellCapacity = checkedShannons(
    CONTRACT_CAPACITY.jobCellV1 + reward,
    "deadline job cell capacity",
  );
  const campaignCellCapacity = checkedShannons(
    CONTRACT_CAPACITY.campaignCellV1 + pledged,
    "campaign cell capacity",
  );
  const occupiedTotal = checkedShannons(
    CONTRACT_CAPACITY.jobCellV1 + CONTRACT_CAPACITY.campaignCellV1,
    "deadline occupied capacity",
  );
  const maximumLockedTotal = checkedShannons(
    jobCellCapacity + campaignCellCapacity,
    "deadline locked total",
  );
  const estimatedFee = estimateTransactionFeeRange(input.creationFee);

  return freezeQuote({
    kind: "deadline",
    executions: parseRunCount(1n),
    occupiedCapacity: {
      jobCell: CONTRACT_CAPACITY.jobCellV1,
      applicationCell: CONTRACT_CAPACITY.campaignCellV1,
      total: occupiedTotal,
    },
    applicationAmount: { perExecution: pledged, total: pledged },
    rewards: { perExecution: reward, total: reward },
    remainingBudget: reward,
    residualRefund: CONTRACT_CAPACITY.jobCellV1,
    retainedTerminalCapacity: CONTRACT_CAPACITY.campaignCellV1,
    estimatedFee,
    maximumLockedTotal,
    maximumOwnerFunding: checkedShannons(
      maximumLockedTotal + estimatedFee.maximum,
      "deadline owner funding",
    ),
  });
}
