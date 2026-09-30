import assert from "node:assert/strict";
import test from "node:test";

import type { ApiDaoHarvestBuild } from "@ckb-automata/api-client";
import { parseHash32, type UnsignedDeadlineTransaction } from "@ckb-automata/core";

import {
  verifyCompletedDaoHarvestTransaction,
  verifyCompletedDaoHarvestOwnerAction,
  verifyDaoHarvestSetupBuild,
} from "./dao-harvest-review.ts";

const hash = (character: string) => parseHash32(`0x${character.repeat(64)}`);
const script = { codeHash: hash("1"), hashType: "type" as const, args: "0x" as const };
const transaction: UnsignedDeadlineTransaction = {
  version: "0x0" as const,
  cellDeps: [],
  headerDeps: [],
  inputs: [],
  outputs: [
    { capacity: `0x${10_200_000_000n.toString(16)}`, lock: script, type: script },
    { capacity: `0x${12_200_000_000n.toString(16)}`, lock: script, type: script },
  ],
  outputsData: ["0x0000000000000000", "0x01"],
  witnesses: ["0x"],
};
const build: ApiDaoHarvestBuild = {
  operation: "setup",
  transaction,
  signingEntries: [{}],
  jobId: hash("2"),
  policyCriticalHash: hash("3"),
  intent: {
    ownerLockHash: hash("4"),
    payoutLockHash: hash("5"),
    principal: "10200000000",
    totalCycles: 1,
  },
};

test("review decoder accepts the exact displayed harvest intent", () => {
  assert.doesNotThrow(() =>
    verifyDaoHarvestSetupBuild(build, {
      ownerLockHash: hash("4"),
      payoutLockHash: hash("5"),
      principal: 10_200_000_000n,
      totalCycles: 1,
    }),
  );
});

test("owner action funding preserves every contract-controlled output", () => {
  assert.doesNotThrow(() =>
    verifyCompletedDaoHarvestOwnerAction(transaction, {
      ...transaction,
      inputs: [{ since: "0x0", previousOutput: { txHash: hash("8"), index: "0x0" } }],
      outputs: [
        ...transaction.outputs,
        { capacity: `0x${100_000_000_000n.toString(16)}`, lock: script, type: null },
      ],
      outputsData: [...transaction.outputsData, "0x"],
      witnesses: [...transaction.witnesses, "0x"],
    }),
  );
  assert.throws(
    () =>
      verifyCompletedDaoHarvestOwnerAction(transaction, {
        ...transaction,
        outputsData: [transaction.outputsData[0]!, "0x02"],
      }),
    /changed the reviewed owner action/,
  );
});

test("review decoder rejects principal, payout, and layout changes", () => {
  assert.throws(
    () =>
      verifyDaoHarvestSetupBuild(
        { ...build, intent: { ...build.intent, payoutLockHash: hash("6") } },
        {
          ownerLockHash: hash("4"),
          payoutLockHash: hash("5"),
          principal: 10_200_000_000n,
          totalCycles: 1,
        },
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      verifyDaoHarvestSetupBuild(
        { ...build, transaction: { ...transaction, outputs: transaction.outputs.slice(0, 1) } },
        {
          ownerLockHash: hash("4"),
          payoutLockHash: hash("5"),
          principal: 10_200_000_000n,
          totalCycles: 1,
        },
      ),
    /output layout/,
  );
});

test("wallet completion may add inputs and change but cannot alter required outputs", () => {
  assert.doesNotThrow(() =>
    verifyCompletedDaoHarvestTransaction(transaction, {
      ...transaction,
      inputs: [{ since: "0x0", previousOutput: { txHash: hash("7"), index: "0x0" } }],
      outputs: [
        ...transaction.outputs,
        { capacity: `0x${100_000_000_000n.toString(16)}`, lock: script, type: null },
      ],
      outputsData: [...transaction.outputsData, "0x"],
    }),
  );
  assert.throws(
    () =>
      verifyCompletedDaoHarvestTransaction(transaction, {
        ...transaction,
        outputs: [
          { ...transaction.outputs[0]!, capacity: "0x1" as const },
          transaction.outputs[1]!,
        ],
      }),
    /changed the reviewed/,
  );
});
