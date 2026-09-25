import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { clientAcceptsDeadlineRequest, validateDeadlineStep } from "./deadline-form.ts";
import { ckbToShannons } from "./ckb-amount.ts";

interface Fixture {
  readonly valid: Record<string, unknown> & {
    readonly pledges: readonly Record<string, unknown>[];
  };
  readonly invalid: readonly {
    readonly name: string;
    readonly patch?: Readonly<Record<string, unknown>>;
    readonly pledgePatch?: Readonly<Record<string, unknown>>;
    readonly outPointPatch?: Readonly<Record<string, unknown>>;
  }[];
}

function invalidRequest(valid: Fixture["valid"], invalid: Fixture["invalid"][number]) {
  const pledge = valid.pledges[0] ?? {};
  const outPoint = (pledge["outPoint"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...valid,
    ...invalid.patch,
    pledges: [
      {
        ...pledge,
        ...invalid.pledgePatch,
        outPoint: { ...outPoint, ...invalid.outPointPatch },
      },
    ],
  };
}

test("deadline form converts CKB without floating-point loss", () => {
  assert.equal(ckbToShannons("61"), "6100000000");
  assert.equal(ckbToShannons("61.00000001"), "6100000001");
  assert.equal(ckbToShannons("184467440737.09551615"), "18446744073709551615");
  assert.equal(ckbToShannons("90071992.54740993"), "9007199254740993");
  assert.throws(() => ckbToShannons("1.000000001"));
  assert.throws(() => ckbToShannons("01"));
});

test("deadline form reports the exact one-shannon target minimum", async () => {
  const errors = await validateDeadlineStep(
    "details",
    {
      pledgeCkb: "61",
      targetCkb: "0",
      successAddress: "success",
      refundAddress: "refund",
    },
    {
      ownerLockHash: undefined,
      resolveLockHash: async () => `0x${"22".repeat(32)}`,
      walletReady: false,
    },
  );
  assert.equal(errors["targetCkb"], "condition amount must be at least 0.00000001 CKB.");
});

test("deadline form rejects the connected wallet as the recipient", async () => {
  const ownerLockHash = `0x${"22".repeat(32)}`;
  const errors = await validateDeadlineStep(
    "details",
    {
      pledgeCkb: "61",
      targetCkb: "100",
      successAddress: "owner",
      refundAddress: "refund",
    },
    {
      ownerLockHash,
      resolveLockHash: async (address) =>
        address === "owner" ? ownerLockHash : `0x${"33".repeat(32)}`,
      walletReady: true,
    },
  );
  assert.equal(
    errors["successAddress"],
    "Recipient address must be different from your connected wallet.",
  );
});

test("deadline client rejects every invalid API fixture", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../../contracts/fixtures/deadline_request_validation_v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Fixture;
  assert.equal(clientAcceptsDeadlineRequest(fixture.valid), true);
  for (const invalid of fixture.invalid) {
    assert.equal(
      clientAcceptsDeadlineRequest(invalidRequest(fixture.valid, invalid)),
      false,
      invalid.name,
    );
  }
});

test("deadline form asks for addresses and never raw scripts or hashes", async () => {
  const source = await readFile(new URL("./deadline-setup.tsx", import.meta.url), "utf8");
  for (const field of [
    "pledgeCkb",
    "targetCkb",
    "successAddress",
    "refundAddress",
    "deadlineBlock",
    "rewardCkb",
    "ownerAddress",
  ]) {
    assert.match(source, new RegExp(`name="${field}"`));
  }
  assert.doesNotMatch(source, /name="[^"]*(?:script|hash|outPoint)/i);
  assert.equal(source.match(/label: "Use mine"/g)?.length, 1);
  assert.match(source, /endAction=\{\{/);
  assert.doesNotMatch(source, /Use connected wallet/);
});
