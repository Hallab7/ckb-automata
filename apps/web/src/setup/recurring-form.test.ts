import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseHash32 } from "@ckb-automata/core";

import {
  clientAcceptsRecurringRequest,
  recurringFundingPreview,
  validateRecurringStep,
} from "./recurring-form.ts";

const HASH = `0x${"22".repeat(32)}`;
const STANDARD_LOCK = Object.freeze({
  codeHash: parseHash32(`0x${"11".repeat(32)}`),
  hashType: "type" as const,
  args: `0x${"22".repeat(20)}` as const,
});
const CCC_LOCK = Object.freeze({ ...STANDARD_LOCK, args: `0x${"22".repeat(22)}` as const });
const VALID_DRAFT = {
  amountCkb: "100",
  firstExecutionBlock: "15000000",
  intervalBlocks: "100",
  recipientAddress: "recipient",
  rewardCkb: "61",
  runCount: "3",
};
const CONTEXT = {
  balanceShannons: 100_000_000_000n,
  ownerLockHash: HASH,
  resolveLock: async () => STANDARD_LOCK,
  resolveLockHash: async () => HASH,
  walletReady: true,
};

interface Fixture {
  readonly valid: Readonly<Record<string, unknown>>;
  readonly invalid: readonly {
    readonly name: string;
    readonly patch: Readonly<Record<string, unknown>>;
  }[];
}

test("recurring preview exposes every component of the locked total", () => {
  const preview = recurringFundingPreview(VALID_DRAFT);
  assert.equal(preview.amountPerRun, 10_000_000_000n);
  assert.equal(preview.payoutTotal, 30_000_000_000n);
  assert.equal(preview.rewardTotal, 18_300_000_000n);
  assert.equal(preview.occupiedCapacity, 38_100_000_000n);
  assert.equal(preview.totalLocked, 86_400_000_000n);
  assert.equal(preview.totalLockedCkb, "864");
});

test("recurring validation rejects invalid addresses, intervals, and run counts", async () => {
  const addressErrors = await validateRecurringStep("details", VALID_DRAFT, {
    ...CONTEXT,
    resolveLockHash: async () => {
      throw new Error("invalid address");
    },
  });
  assert.match(addressErrors["recipientAddress"] ?? "", /valid CKB testnet/);

  const intervalErrors = await validateRecurringStep(
    "timing",
    { ...VALID_DRAFT, intervalBlocks: "0" },
    CONTEXT,
  );
  assert.match(intervalErrors["intervalBlocks"] ?? "", /at least 1 block/);

  const runErrors = await validateRecurringStep(
    "timing",
    { ...VALID_DRAFT, runCount: "4294967296" },
    CONTEXT,
  );
  assert.match(runErrors["runCount"] ?? "", /4,294,967,295/);
});

test("recurring validation rejects overflow and insufficient wallet balance", async () => {
  assert.throws(() =>
    recurringFundingPreview({
      ...VALID_DRAFT,
      amountCkb: "184467440737.09551615",
      runCount: "2",
    }),
  );
  const errors = await validateRecurringStep("funding", VALID_DRAFT, {
    ...CONTEXT,
    balanceShannons: 86_399_999_999n,
  });
  assert.equal(errors["ownerAddress"], "Wallet balance is below the 864 CKB locked total.");
});

test("recurring validation uses the resolved recipient address minimum", async () => {
  const errors = await validateRecurringStep(
    "details",
    { ...VALID_DRAFT, amountCkb: "61" },
    { ...CONTEXT, resolveLock: async () => CCC_LOCK },
  );
  assert.equal(
    errors["amountCkb"],
    "Payment per run must be at least 63 CKB for this recipient address.",
  );
});

test("recurring client rejects every invalid API fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../../contracts/fixtures/recurring_request_validation_v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Fixture;
  assert.equal(clientAcceptsRecurringRequest(fixture.valid), true);
  for (const invalid of fixture.invalid) {
    assert.equal(
      clientAcceptsRecurringRequest({ ...fixture.valid, ...invalid.patch }),
      false,
      invalid.name,
    );
  }
});

test("recurring form asks for plain-language values and no raw scripts", async () => {
  const source = await readFile(new URL("./recurring-setup.tsx", import.meta.url), "utf8");
  for (const field of [
    "recipientAddress",
    "amountCkb",
    "firstExecutionBlock",
    "intervalBlocks",
    "runCount",
    "rewardCkb",
    "ownerAddress",
    "finalRefund",
  ]) {
    assert.match(source, new RegExp(`name="${field}"`));
  }
  assert.doesNotMatch(source, /name="[^"]*(?:script|hash|outPoint)/i);
});
