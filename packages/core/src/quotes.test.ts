import assert from "node:assert/strict";
import test from "node:test";

import benchmarks from "../../../contracts/benchmarks.json" with { type: "json" };

import { MAX_UINT64 } from "./chain-values.ts";
import { CONTRACT_CAPACITY } from "./contract-costs.ts";
import {
  calculateDeadlineQuote,
  calculateRecurringQuote,
  estimateTransactionFeeRange,
  type FeeRangeInput,
} from "./quotes.ts";

const creationFee: FeeRangeInput = {
  transactionBytes: { minimum: "700", maximum: "900" },
  feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
};

test("quotes use the exact occupied capacities measured by contract benchmarks", () => {
  const measured = Object.fromEntries(
    benchmarks.capacities.map(({ id, occupiedShannons }) => [id, BigInt(occupiedShannons)]),
  );
  const recurring = calculateRecurringQuote({
    amountPerExecution: "20000000000",
    rewardPerExecution: "10000000000",
    executions: "3",
    creationFee,
  });
  const deadline = calculateDeadlineQuote({
    pledgedAmount: "20000000000",
    reward: "10000000000",
    creationFee,
  });

  assert.equal(recurring.occupiedCapacity.jobCell, measured["job-cell-v1"]);
  assert.equal(deadline.occupiedCapacity.applicationCell, measured["campaign-cell-v1"]);
  assert.equal(CONTRACT_CAPACITY.plainWalletCell, measured["plain-wallet-cell"]);
});

test("recurring quote accounts for every payout and reward with a terminal residual", () => {
  const quote = calculateRecurringQuote({
    amountPerExecution: "20000000000",
    rewardPerExecution: "10000000000",
    executions: "3",
    creationFee,
  });

  assert.equal(quote.applicationAmount.total, 60_000_000_000n);
  assert.equal(quote.rewards.total, 30_000_000_000n);
  assert.equal(quote.remainingBudget, 90_000_000_000n);
  assert.equal(quote.residualRefund, 38_100_000_000n);
  assert.equal(quote.maximumLockedTotal, 128_100_000_000n);
  assert.deepEqual(quote.estimatedFee, { minimum: 700n, maximum: 1_800n });
  assert.equal(quote.maximumOwnerFunding, 128_100_001_800n);
  assert.ok(Object.isFrozen(quote.applicationAmount));
});

test("deadline quote separates campaign value, reward budget, and retained marker", () => {
  const quote = calculateDeadlineQuote({
    pledgedAmount: "20000000000",
    reward: "10000000000",
    creationFee,
  });

  assert.equal(quote.applicationAmount.total, 20_000_000_000n);
  assert.equal(quote.rewards.total, 10_000_000_000n);
  assert.equal(quote.remainingBudget, 10_000_000_000n);
  assert.equal(quote.occupiedCapacity.total, 65_400_000_000n);
  assert.equal(quote.residualRefund, 38_100_000_000n);
  assert.equal(quote.retainedTerminalCapacity, 27_300_000_000n);
  assert.equal(quote.maximumLockedTotal, 95_400_000_000n);
  assert.equal(quote.maximumOwnerFunding, 95_400_001_800n);
});

test("fee estimates round upward at shannons per thousand bytes", () => {
  assert.deepEqual(
    estimateTransactionFeeRange({
      transactionBytes: { minimum: "1", maximum: "1001" },
      feeRatePerKilobyte: { minimum: "1", maximum: "1000" },
    }),
    { minimum: 1n, maximum: 1_001n },
  );
});

test("quotes reject unfundable outputs, unsafe ranges, and uint64 overflow", () => {
  assert.throws(
    () =>
      calculateRecurringQuote({
        amountPerExecution: CONTRACT_CAPACITY.plainWalletCell - 1n,
        rewardPerExecution: "10000000000",
        executions: "3",
        creationFee,
      }),
    /plain output minimum/,
  );
  assert.throws(
    () =>
      calculateDeadlineQuote({
        pledgedAmount: "20000000000",
        reward: CONTRACT_CAPACITY.plainWalletCell - 1n,
        creationFee,
      }),
    /plain output minimum/,
  );
  assert.throws(
    () =>
      calculateRecurringQuote({
        amountPerExecution: MAX_UINT64,
        rewardPerExecution: "10000000000",
        executions: "2",
        creationFee,
      }),
    /exceeds uint64/,
  );
  assert.throws(
    () =>
      estimateTransactionFeeRange({
        transactionBytes: { minimum: "900", maximum: "700" },
        feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
      }),
    /ordered/,
  );
  assert.throws(
    () =>
      estimateTransactionFeeRange({
        transactionBytes: { minimum: 700 as never, maximum: "900" },
        feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      calculateRecurringQuote({
        amountPerExecution: "20000000000",
        rewardPerExecution: "10000000000",
        executions: 3 as never,
        creationFee,
      }),
    TypeError,
  );
});
