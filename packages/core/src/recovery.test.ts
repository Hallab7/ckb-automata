import assert from "node:assert/strict";
import test from "node:test";

import { JobDataV1, type JobDataV1Like } from "@ckb-automata/molecule";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import type { LiveCellResolver, ResolvedLiveCell } from "./cancellation.ts";
import { parseHash32, parseOutPoint } from "./chain-values.ts";
import { deploymentRegistry, type RegisteredDeployment } from "./deployment-registry.ts";
import type { ScriptIdentity } from "./job-inspection.ts";
import {
  RecoveryBuildError,
  assertRecoveryCompletion,
  buildRecovery,
  type RecoveryReason,
} from "./recovery.ts";
import { buildRecurringCreation } from "./recurring-creation.ts";

const jobOutPoint = parseOutPoint({ txHash: `0x${"55".repeat(32)}`, index: "0" });

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

function liveCell(value: RegisteredDeployment, owner: ScriptIdentity): ResolvedLiveCell {
  const build = buildRecurringCreation({
    deployment: value,
    ownerLockHash: parseHash32(scriptToHash(owner)),
    recipientLockHash: parseHash32(scriptToHash(owner)),
    amount: "10000000000",
    intervalBlocks: "100",
    firstNotBefore: "500",
    totalRuns: "2",
    reward: "10000000000",
    creatorNonce: "47",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "800" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const output = build.transaction.outputs[0];
  assert.ok(output);
  return { outPoint: jobOutPoint, output, data: build.jobData };
}

function mutate(cell: ResolvedLiveCell, overrides: Partial<JobDataV1Like>): ResolvedLiveCell {
  const decoded = JobDataV1.unpack(
    typeof cell.data === "string" ? hexToBytes(cell.data) : cell.data,
  );
  return {
    ...cell,
    data: bytesToHex(JobDataV1.pack({ ...decoded, ...overrides })) as `0x${string}`,
  };
}

test("each recovery reason produces an explicit exact-refund preview", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  const base = liveCell(registered, owner);
  const cases: readonly [RecoveryReason, ResolvedLiveCell, string][] = [
    ["terminal_operational_failure", base, "ok"],
    ["unsupported_metadata", mutate(base, { version: 2 }), "unsupported_version"],
    ["invalid_application_state", mutate(base, { state: 1 }), "invalid_job"],
    [
      "unsupported_metadata",
      mutate(base, { policy_script_hash: Array.from({ length: 32 }, () => 0x99) }),
      "policy_mismatch",
    ],
  ];
  for (const [reason, cell, inspectionStatus] of cases) {
    const build = await buildRecovery({
      deployment: registered,
      resolver: resolver(cell),
      jobOutPoint,
      ownerLock: owner,
      reason,
    });
    assert.equal(build.inspection.status, inspectionStatus);
    assert.deepEqual(build.preview, {
      jobOutPoint,
      jobId: build.preview.jobId,
      reason,
      refund: {
        capacity: BigInt(cell.output.capacity),
        lock: owner,
        type: null,
        data: "0x",
      },
      paysExecutorReward: false,
      createsSuccessor: false,
    });
    assert.equal(build.transaction.witnesses.length, 1);
  }
});

test("recovery reason selection fails closed when it contradicts inspection", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  const base = liveCell(registered, owner);
  await assert.rejects(
    buildRecovery({
      deployment: registered,
      resolver: resolver(base),
      jobOutPoint,
      ownerLock: owner,
      reason: "invalid_application_state",
    }),
    (error: unknown) =>
      error instanceof RecoveryBuildError &&
      error.code === "REASON_MISMATCH" &&
      /does not match/.test(error.message),
  );
  await assert.rejects(
    buildRecovery({
      deployment: registered,
      resolver: resolver({ ...base, output: { ...base.output, type: null } }),
      jobOutPoint,
      ownerLock: owner,
      reason: "terminal_operational_failure",
    }),
    (error: unknown) => error instanceof RecoveryBuildError && error.code === "REASON_MISMATCH",
  );
});

test("stale, wrong-owner, malformed, and unknown-policy cells are actionable", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  const base = liveCell(registered, owner);
  await assert.rejects(
    buildRecovery({
      deployment: registered,
      resolver: resolver(null),
      jobOutPoint,
      ownerLock: owner,
      reason: "terminal_operational_failure",
    }),
    (error: unknown) => error instanceof RecoveryBuildError && error.code === "STALE_OUTPOINT",
  );
  await assert.rejects(
    buildRecovery({
      deployment: registered,
      resolver: resolver(base),
      jobOutPoint,
      ownerLock: ownerLock(registered, `0x${"ab".repeat(20)}`),
      reason: "terminal_operational_failure",
    }),
    (error: unknown) => error instanceof RecoveryBuildError && error.code === "OWNER_MISMATCH",
  );
  await assert.rejects(
    buildRecovery({
      deployment: registered,
      resolver: resolver({ ...base, data: "0x00" }),
      jobOutPoint,
      ownerLock: owner,
      reason: "unsupported_metadata",
    }),
    (error: unknown) => error instanceof RecoveryBuildError && error.code === "INVALID_JOB_CELL",
  );
  await assert.rejects(
    buildRecovery({
      deployment: registered,
      resolver: resolver({
        ...base,
        output: {
          ...base.output,
          type: { codeHash: parseHash32(`0x${"cc".repeat(32)}`), hashType: "data1", args: "0x" },
        },
      }),
      jobOutPoint,
      ownerLock: owner,
      reason: "unsupported_metadata",
    }),
    (error: unknown) => error instanceof RecoveryBuildError && error.code === "UNSUPPORTED_POLICY",
  );
});

test("wallet completion cannot redirect recovery or change its witness mode", async () => {
  const registered = await deployment();
  const owner = ownerLock(registered);
  const build = await buildRecovery({
    deployment: registered,
    resolver: resolver(liveCell(registered, owner)),
    jobOutPoint,
    ownerLock: owner,
    reason: "terminal_operational_failure",
  });
  const completed = {
    ...build.transaction,
    inputs: [
      ...build.transaction.inputs,
      {
        since: "0x0" as const,
        previousOutput: { txHash: parseHash32(`0x${"66".repeat(32)}`), index: "0x0" as const },
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
  assert.doesNotThrow(() => assertRecoveryCompletion(build, completed));
  assert.throws(
    () =>
      assertRecoveryCompletion(build, {
        ...completed,
        outputs: [{ ...completed.outputs[0]!, capacity: "0x1" }, ...completed.outputs.slice(1)],
      }),
    /exact recovery refund/,
  );
  assert.throws(
    () =>
      assertRecoveryCompletion(build, {
        ...completed,
        witnesses: [
          serializeWitnessArgs({ lock: "", inputType: "0x01", outputType: "" }) as `0x${string}`,
          completed.witnesses[1]!,
        ],
      }),
    /recovery operation/,
  );
});
