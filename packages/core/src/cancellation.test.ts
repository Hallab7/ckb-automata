import assert from "node:assert/strict";
import test from "node:test";

import { scriptToHash, serializeWitnessArgs } from "@nervosnetwork/ckb-sdk-utils";

import {
  CancellationBuildError,
  assertCancellationCompletion,
  buildCancellation,
  type LiveCellResolver,
  type ResolvedLiveCell,
} from "./cancellation.ts";
import { parseHash32, parseOutPoint } from "./chain-values.ts";
import { buildDeadlineCreation } from "./deadline-creation.ts";
import { deploymentRegistry, type RegisteredDeployment } from "./deployment-registry.ts";
import type { ScriptIdentity } from "./job-inspection.ts";
import { buildRecurringCreation } from "./recurring-creation.ts";

const jobOutPoint = parseOutPoint({ txHash: `0x${"77".repeat(32)}`, index: "0" });
const ownerInput = {
  since: "0x0" as const,
  previousOutput: {
    txHash: parseHash32(`0x${"88".repeat(32)}`),
    index: "0x1" as const,
  },
};

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
    recipientLockHash: parseHash32(`0x${"22".repeat(32)}`),
    amount: "10000000000",
    intervalBlocks: "100",
    firstNotBefore: "500",
    totalRuns: "3",
    reward: "10000000000",
    creatorNonce: "46",
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
  const build = buildDeadlineCreation({
    deployment: value,
    pledges: [
      {
        outPoint: parseOutPoint({ txHash: `0x${"99".repeat(32)}`, index: "0" }),
        refundLockHash: parseHash32(scriptToHash(owner)),
        amount: "10000000000",
      },
    ],
    target: "10000000000",
    deadlineBlock: "500",
    successLockHash: parseHash32(`0x${"33".repeat(32)}`),
    cancelLockHash: parseHash32(scriptToHash(owner)),
    reward: "10000000000",
    creatorNonce: "46",
    creationFee: {
      transactionBytes: { minimum: "700", maximum: "1000" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const output = build.transaction.outputs[1];
  assert.ok(output);
  return { outPoint: jobOutPoint, output, data: build.jobData };
}

test("cancellation resolves recurring and deadline jobs into exact owner refunds", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  for (const [expectedKind, cell] of [
    ["recurring", recurringCell(registered, owner)],
    ["deadline", deadlineCell(registered, owner)],
  ] as const) {
    const build = await buildCancellation({
      deployment: registered,
      resolver: resolver(cell),
      jobOutPoint,
      ownerLock: owner,
    });
    assert.equal(build.policy.kind, expectedKind);
    assert.deepEqual(build.transaction.inputs[0]?.previousOutput, {
      txHash: jobOutPoint.txHash,
      index: "0x0",
    });
    assert.deepEqual(build.transaction.outputs, [
      { capacity: cell.output.capacity, lock: owner, type: null },
    ]);
    assert.deepEqual(build.transaction.outputsData, ["0x"]);
    assert.equal(build.transaction.cellDeps.length, 3);
  }
});

test("stale outpoints and wrong owners return actionable error codes", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  await assert.rejects(
    buildCancellation({
      deployment: registered,
      resolver: resolver(null),
      jobOutPoint,
      ownerLock: owner,
    }),
    (error: unknown) =>
      error instanceof CancellationBuildError &&
      error.code === "STALE_OUTPOINT" &&
      /refresh before cancelling/.test(error.message),
  );
  await assert.rejects(
    buildCancellation({
      deployment: registered,
      resolver: resolver(recurringCell(registered, owner)),
      jobOutPoint,
      ownerLock: ownerLock(registered, `0x${"ab".repeat(20)}`),
    }),
    (error: unknown) =>
      error instanceof CancellationBuildError &&
      error.code === "OWNER_MISMATCH" &&
      /requires 0x/.test(error.message),
  );
});

test("wallet completion preserves the cancellation operation and exact refund", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  const build = await buildCancellation({
    deployment: registered,
    resolver: resolver(recurringCell(registered, owner)),
    jobOutPoint,
    ownerLock: owner,
  });
  assert.throws(
    () => assertCancellationCompletion(build, build.transaction),
    /owner-authentication input/,
  );
  const completed = {
    ...build.transaction,
    inputs: [...build.transaction.inputs, ownerInput],
    outputs: [
      ...build.transaction.outputs,
      { capacity: "0x174876e800" as const, lock: owner, type: null },
    ],
    outputsData: [...build.transaction.outputsData, "0x" as const],
    witnesses: [
      build.transaction.witnesses[0] as `0x${string}`,
      serializeWitnessArgs({
        lock: `0x${"00".repeat(65)}`,
        inputType: "",
        outputType: "",
      }) as `0x${string}`,
    ],
  };
  assert.doesNotThrow(() => assertCancellationCompletion(build, completed));
  assert.throws(
    () =>
      assertCancellationCompletion(build, {
        ...completed,
        outputs: [{ ...completed.outputs[0]!, capacity: "0x1" }, ...completed.outputs.slice(1)],
      }),
    /exact owner refund/,
  );
  assert.throws(
    () =>
      assertCancellationCompletion(build, {
        ...completed,
        witnesses: [
          serializeWitnessArgs({ lock: "", inputType: "0x02", outputType: "" }) as `0x${string}`,
          completed.witnesses[1]!,
        ],
      }),
    /cancellation operation/,
  );
});

test("non-job cells and unregistered policies fail closed", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  const cell = recurringCell(registered, owner);
  await assert.rejects(
    buildCancellation({
      deployment: registered,
      resolver: resolver({
        ...cell,
        output: { ...cell.output, lock: owner },
      }),
      jobOutPoint,
      ownerLock: owner,
    }),
    (error: unknown) =>
      error instanceof CancellationBuildError && error.code === "INVALID_JOB_CELL",
  );
  await assert.rejects(
    buildCancellation({
      deployment: registered,
      resolver: resolver({
        ...cell,
        output: {
          ...cell.output,
          type: { codeHash: parseHash32(`0x${"cc".repeat(32)}`), hashType: "data1", args: "0x" },
        },
      }),
      jobOutPoint,
      ownerLock: owner,
    }),
    (error: unknown) =>
      error instanceof CancellationBuildError && error.code === "UNSUPPORTED_POLICY",
  );
});
