import assert from "node:assert/strict";
import test from "node:test";

import { JobDataV1 } from "@ckb-automata/molecule";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import type { LiveCellResolver, ResolvedLiveCell } from "./cancellation.ts";
import { parseHash32, parseOutPoint } from "./chain-values.ts";
import { buildDeadlineCreation } from "./deadline-creation.ts";
import { deploymentRegistry, type RegisteredDeployment } from "./deployment-registry.ts";
import type { ScriptIdentity } from "./job-inspection.ts";
import { buildRecurringCreation } from "./recurring-creation.ts";
import {
  TopUpBuildError,
  assertTopUpCompletion,
  buildTopUp,
  inspectTopUpDiff,
  type JobCellSnapshot,
} from "./top-up.ts";

const jobOutPoint = parseOutPoint({ txHash: `0x${"47".repeat(32)}`, index: "0" });

async function deployment(): Promise<RegisteredDeployment> {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("local deployment is unavailable");
  return loaded.deployment;
}

function ownerLock(
  value: RegisteredDeployment,
  args = value.manifest.fixtureWallet.lockArg,
): ScriptIdentity {
  return {
    codeHash: value.manifest.secp256k1Blake160.codeHash,
    hashType: value.manifest.secp256k1Blake160.hashType,
    args,
  };
}

function resolver(cell: ResolvedLiveCell | null): LiveCellResolver {
  return {
    async resolve() {
      return cell;
    },
  };
}

function recurringCell(value: RegisteredDeployment, owner: ScriptIdentity): ResolvedLiveCell {
  const build = buildRecurringCreation({
    deployment: value,
    ownerLockHash: parseHash32(scriptToHash(owner)),
    recipientLockHash: parseHash32(scriptToHash(owner)),
    amount: "10000000000",
    intervalBlocks: "100",
    firstNotBefore: "500",
    totalRuns: "2",
    reward: "10000000000",
    creatorNonce: "48",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "800" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const output = build.transaction.outputs[0];
  assert.ok(output);
  return { outPoint: jobOutPoint, output, data: build.jobData };
}

function deadlineCell(value: RegisteredDeployment, owner: ScriptIdentity): ResolvedLiveCell {
  const ownerHash = parseHash32(scriptToHash(owner));
  const build = buildDeadlineCreation({
    deployment: value,
    pledges: [
      {
        outPoint: parseOutPoint({ txHash: `0x${"48".repeat(32)}`, index: "0" }),
        refundLockHash: ownerHash,
        amount: "10000000000",
      },
    ],
    target: "10000000000",
    deadlineBlock: "500",
    successLockHash: ownerHash,
    cancelLockHash: ownerHash,
    reward: "10000000000",
    creatorNonce: "48",
    creationFee: {
      transactionBytes: { minimum: "700", maximum: "1000" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const output = build.transaction.outputs[1];
  assert.ok(output);
  return { outPoint: jobOutPoint, output, data: build.jobData };
}

test("top-up preserves intent for recurring and deadline policies", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  for (const cell of [recurringCell(registered, owner), deadlineCell(registered, owner)]) {
    const recurring = cell.output.type?.args === "0x";
    const build = await buildTopUp({
      deployment: registered,
      resolver: resolver(cell),
      jobOutPoint,
      ownerLock: owner,
      rewardIncrease: recurring ? "0" : "1000000000",
      budgetIncrease: "10000000000",
      capacityIncrease: "10000000000",
    });
    assert.equal(build.diff.classification, "top_up");
    assert.deepEqual(build.diff.immutableChanges, []);
    assert.equal(build.diff.funding.reward.delta, recurring ? 0n : 1_000_000_000n);
    assert.equal(build.diff.funding.remainingBudget.delta, 10_000_000_000n);
    assert.equal(build.diff.funding.capacity.delta, 10_000_000_000n);
    assert.deepEqual(build.transaction.outputs[0]?.lock, cell.output.lock);
    assert.deepEqual(build.transaction.outputs[0]?.type, cell.output.type);
  }
});

test("transaction diff inspector distinguishes edits and migration", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  const cell = recurringCell(registered, owner);
  const build = await buildTopUp({
    deployment: registered,
    resolver: resolver(cell),
    jobOutPoint,
    ownerLock: owner,
    rewardIncrease: "0",
    budgetIncrease: "10000000000",
    capacityIncrease: "10000000000",
  });
  const successor: JobCellSnapshot = {
    ...build.transaction.outputs[0]!,
    data: build.transaction.outputsData[0]!,
  };
  const decoded = JobDataV1.unpack(hexToBytes(successor.data as `0x${string}`));
  const edited: JobCellSnapshot = {
    ...successor,
    data: bytesToHex(
      JobDataV1.pack({
        ...decoded,
        payload_hash: Array.from({ length: 32 }, () => 0xaa),
      }),
    ) as `0x${string}`,
  };
  const diff = inspectTopUpDiff(
    {
      capacity: cell.output.capacity,
      lock: cell.output.lock,
      type: cell.output.type,
      data: cell.data,
    },
    edited,
  );
  assert.equal(diff.classification, "edit_or_migration");
  assert.deepEqual(diff.immutableChanges, ["payload_hash"]);
  const migrated = inspectTopUpDiff(
    {
      capacity: cell.output.capacity,
      lock: cell.output.lock,
      type: cell.output.type,
      data: cell.data,
    },
    { ...successor, lock: owner },
  );
  assert.equal(migrated.classification, "edit_or_migration");
  assert.deepEqual(migrated.immutableChanges, ["lock_script"]);
});

test("top-up rejects stale, wrong-owner, no-op, and unfunded requests", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  const cell = recurringCell(registered, owner);
  const baseline = {
    deployment: registered,
    jobOutPoint,
    ownerLock: owner,
    rewardIncrease: "0",
    budgetIncrease: "10000000000",
    capacityIncrease: "10000000000",
  } as const;
  await assert.rejects(
    buildTopUp({
      ...baseline,
      resolver: resolver(cell),
      rewardIncrease: "1000000000",
    }),
    (error: unknown) =>
      error instanceof TopUpBuildError &&
      error.code === "INVALID_INCREASE" &&
      /payload-committed/.test(error.message),
  );
  await assert.rejects(
    buildTopUp({ ...baseline, resolver: resolver(null) }),
    (error: unknown) => error instanceof TopUpBuildError && error.code === "STALE_OUTPOINT",
  );
  await assert.rejects(
    buildTopUp({
      ...baseline,
      resolver: resolver(cell),
      ownerLock: ownerLock(registered, `0x${"ab".repeat(20)}`),
    }),
    (error: unknown) => error instanceof TopUpBuildError && error.code === "OWNER_MISMATCH",
  );
  await assert.rejects(
    buildTopUp({
      ...baseline,
      resolver: resolver(cell),
      rewardIncrease: "0",
      budgetIncrease: "0",
      capacityIncrease: "10000000000",
    }),
    (error: unknown) => error instanceof TopUpBuildError && error.code === "INVALID_INCREASE",
  );
  await assert.rejects(
    buildTopUp({
      ...baseline,
      resolver: resolver(cell),
      capacityIncrease: "0",
    }),
    (error: unknown) =>
      error instanceof TopUpBuildError &&
      error.code === "INVALID_INCREASE" &&
      /does not fund/.test(error.message),
  );
});

test("wallet completion cannot mutate the successor or operation", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  const build = await buildTopUp({
    deployment: registered,
    resolver: resolver(recurringCell(registered, owner)),
    jobOutPoint,
    ownerLock: owner,
    rewardIncrease: "0",
    budgetIncrease: "10000000000",
    capacityIncrease: "10000000000",
  });
  const completed = {
    ...build.transaction,
    inputs: [
      ...build.transaction.inputs,
      {
        since: "0x0" as const,
        previousOutput: { txHash: parseHash32(`0x${"49".repeat(32)}`), index: "0x0" as const },
      },
    ],
    outputs: [
      ...build.transaction.outputs,
      { capacity: "0x174876e800" as const, lock: owner, type: null },
    ],
    outputsData: [...build.transaction.outputsData, "0x" as const],
    witnesses: [
      build.transaction.witnesses[0]!,
      serializeWitnessArgs({
        lock: `0x${"00".repeat(65)}`,
        inputType: "",
        outputType: "",
      }) as `0x${string}`,
    ],
  };
  assert.doesNotThrow(() => assertTopUpCompletion(build, completed));
  assert.throws(
    () =>
      assertTopUpCompletion(build, {
        ...completed,
        outputsData: ["0x", ...completed.outputsData.slice(1)],
      }),
    /exact top-up successor/,
  );
  assert.throws(
    () =>
      assertTopUpCompletion(build, {
        ...completed,
        witnesses: [
          serializeWitnessArgs({ lock: "", inputType: "0x01", outputType: "" }) as `0x${string}`,
          completed.witnesses[1]!,
        ],
      }),
    /top-up operation/,
  );
});
