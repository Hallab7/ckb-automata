import assert from "node:assert/strict";
import test from "node:test";

import type { ApiDaoHarvestBuild } from "@ckb-automata/api-client";
import { parseHash32, type UnsignedDeadlineTransaction } from "@ckb-automata/core";

import {
  daoHarvestReviewSnapshot,
  verifyCompletedDaoHarvestTransaction,
  verifyCompletedDaoHarvestOwnerAction,
  verifyDaoHarvestSetupBuild,
  verifyRefreshedDaoHarvestPolicy,
} from "./dao-harvest-review.ts";

const hash = (character: string) => parseHash32(`0x${character.repeat(64)}`);
const script = { codeHash: hash("1"), hashType: "type" as const, args: "0x" as const };
const policyDependency = {
  depType: "code" as const,
  outPoint: { txHash: hash("9"), index: "0x1" as const },
};
const transaction: UnsignedDeadlineTransaction = {
  version: "0x0" as const,
  cellDeps: [policyDependency],
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
    creatorNonce: "100",
    executorReward: "6100000000",
    firstPrepareSince: "200",
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

test("review snapshots remain signable for the API quote window", () => {
  assert.deepEqual(daoHarvestReviewSnapshot({ blockHash: hash("a"), blockNumber: "100" }), {
    blockHash: hash("a"),
    blockNumber: "100",
    expiresAfterBlock: "110",
  });
  assert.throws(
    () => daoHarvestReviewSnapshot({ blockHash: hash("a"), blockNumber: "0100" }),
    /invalid snapshot block/,
  );
});

test("approval allows a fresh tip build only when the reviewed policy is unchanged", () => {
  assert.doesNotThrow(() =>
    verifyRefreshedDaoHarvestPolicy(build, {
      ...build,
      jobId: hash("6"),
      policyCriticalHash: hash("7"),
      intent: {
        ...build.intent,
        creatorNonce: "101",
        firstPrepareSince: "201",
      },
      transaction: {
        ...build.transaction,
        outputsData: [build.transaction.outputsData[0]!, "0x02"],
      },
    }),
  );
  assert.throws(
    () =>
      verifyRefreshedDaoHarvestPolicy(build, {
        ...build,
        intent: { ...build.intent, executorReward: "6200000000" },
      }),
    /harvest policy changed/,
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
      cellDeps: [
        {
          depType: "depGroup",
          outPoint: { txHash: hash("8"), index: "0x0" },
        },
        {
          ...policyDependency,
          outPoint: { ...policyDependency.outPoint, index: "0x01" },
        },
      ],
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
  assert.throws(
    () =>
      verifyCompletedDaoHarvestTransaction(transaction, {
        ...transaction,
        cellDeps: [
          {
            depType: "depGroup",
            outPoint: { txHash: hash("8"), index: "0x0" },
          },
        ],
      }),
    /changed the reviewed/,
  );
});
