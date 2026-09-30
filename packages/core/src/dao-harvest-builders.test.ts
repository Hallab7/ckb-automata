import assert from "node:assert/strict";
import test from "node:test";

import { DaoHarvestPayloadV1, JobDataV1 } from "@ckb-automata/molecule";
import { hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import { createEpoch, parseHash32, parseOutPoint } from "./chain-values.ts";
import {
  DaoHarvestBuilderError,
  buildDaoHarvestPrepare,
  buildDaoHarvestSetup,
  type DaoHarvestDeployment,
  type DaoHarvestSetupInput,
} from "./dao-harvest-builders.ts";
import { calculateDaoHarvestQuote } from "./dao-harvest-math.ts";
import { encodeAbsoluteEpochSince, encodeRelativeEpochSince } from "./triggers.ts";

const hash = (digit: string) => parseHash32(`0x${digit.repeat(64)}`);
const dep = (digit: string) => ({
  outPoint: { txHash: hash(digit), index: "0x0" as const },
  depType: "code" as const,
});
const contract = (digit: string) => ({
  script: { codeHash: hash(digit), hashType: "type" as const },
  cellDep: dep(digit),
});

const deployment: DaoHarvestDeployment = {
  network: "ckb_testnet",
  genesisHash: hash("a"),
  manifestSha256: "b".repeat(64),
  secp256k1Blake160: { cellDep: dep("1") },
  jobLock: contract("2"),
  policy: contract("3"),
  vaultLock: contract("4"),
  daoType: contract("5"),
};

function setupInput(overrides: Partial<DaoHarvestSetupInput> = {}): DaoHarvestSetupInput {
  const principal = 10_000_000_000n;
  const reward = 100_000_000n;
  return {
    deployment,
    expectedGenesisHash: deployment.genesisHash,
    ownerLockHash: hash("6"),
    payoutLockHash: hash("7"),
    principal,
    vaultOccupiedCapacity: 6_100_000_000n,
    jobOccupiedCapacity: 2_000_000_000n,
    prepareExecutorLockHashes: [hash("9"), hash("8")],
    executorReward: reward,
    minCompensation: 1n,
    prepareBufferEpochs: encodeRelativeEpochSince(
      createEpoch({ number: 4n, index: 0n, length: 0n }),
    ),
    confirmationMarginEpochs: encodeRelativeEpochSince(
      createEpoch({ number: 1n, index: 0n, length: 0n }),
    ),
    totalCycles: 2n,
    endEpochSince: encodeAbsoluteEpochSince(createEpoch({ number: 600n, index: 0n, length: 0n })),
    firstPrepareSince: encodeAbsoluteEpochSince(
      createEpoch({ number: 200n, index: 0n, length: 0n }),
    ),
    creatorNonce: 1n,
    quote: calculateDaoHarvestQuote({
      principal,
      occupiedCapacity: 6_100_000_000n,
      depositAccumulatedRate: 1_000n,
      projectedWithdrawAccumulatedRate: 1_100n,
      executorReward: reward,
      actions: 4n,
      estimatedNetworkFee: 1_000n,
      snapshotBlock: 100n,
      validUntilBlock: 110n,
    }),
    currentBlock: 105n,
    ...overrides,
  };
}

test("setup builder is deterministic and exposes independently verifiable commitments", () => {
  const first = buildDaoHarvestSetup(setupInput());
  const second = buildDaoHarvestSetup(setupInput());
  assert.deepEqual(first, second);
  assert.equal(first.transaction.outputs.length, 2);
  assert.equal(first.transaction.outputs[0]?.capacity, "0x2540be400");
  assert.equal(first.signingEntries[0]?.role, "owner");
  const payload = DaoHarvestPayloadV1.unpack(hexToBytes(first.payload));
  const job = JobDataV1.unpack(hexToBytes(first.jobData));
  assert.equal(payload.principal_capacity.toString(), "10000000000");
  assert.equal(payload.total_cycles.toString(), "2");
  assert.equal(job.remaining_runs.toString(), "4");
  assert.equal(job.remaining_budget.toString(), "400000000");
  assert.match(first.payloadHash, /^0x[0-9a-f]{64}$/);
  assert.match(first.policyScriptHash, /^0x[0-9a-f]{64}$/);
});

test("setup rejects wrong networks, expired quotes, and undersized principal", () => {
  assert.throws(
    () => buildDaoHarvestSetup(setupInput({ expectedGenesisHash: hash("f") })),
    (error) => error instanceof DaoHarvestBuilderError && error.code === "WRONG_NETWORK",
  );
  assert.throws(
    () => buildDaoHarvestSetup(setupInput({ currentBlock: 111n })),
    (error) => error instanceof DaoHarvestBuilderError && error.code === "EXPIRED_QUOTE",
  );
  assert.throws(
    () => buildDaoHarvestSetup(setupInput({ vaultOccupiedCapacity: 11_000_000_000n })),
    (error) => error instanceof DaoHarvestBuilderError && error.code === "INSUFFICIENT_CAPACITY",
  );
  assert.throws(
    () => buildDaoHarvestSetup(setupInput({ payoutLockHash: hash("6") })),
    (error) => error instanceof DaoHarvestBuilderError && error.code === "UNSAFE_PAYOUT",
  );
});

test("prepare rejects a spent vault outpoint before constructing a transaction", async () => {
  const setup = buildDaoHarvestSetup(setupInput());
  const outPoint = parseOutPoint({ txHash: hash("d"), index: "0" });
  await assert.rejects(
    buildDaoHarvestPrepare({
      deployment,
      expectedGenesisHash: deployment.genesisHash,
      resolver: { resolve: async () => null },
      vaultOutPoint: outPoint,
      jobOutPoint: parseOutPoint({ txHash: hash("e"), index: "1" }),
      authorityOutPoint: parseOutPoint({ txHash: hash("f"), index: "0" }),
      authorityLock: { codeHash: hash("1"), hashType: "type", args: "0x11" },
      authorityLockHash: hash("8"),
      authorityOccupiedCapacity: 6_100_000_000n,
      networkFee: 1_000n,
      payload: setup.payload,
      prepareExecutorLockHashes: [hash("8"), hash("9")],
      depositHeaderHash: hash("c"),
      depositBlockNumber: 100n,
      claimSince: encodeAbsoluteEpochSince(createEpoch({ number: 380n, index: 0n, length: 0n })),
    }),
    (error) => error instanceof DaoHarvestBuilderError && error.code === "STALE_OUTPOINT",
  );
});
