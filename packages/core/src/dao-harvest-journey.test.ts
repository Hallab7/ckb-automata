import assert from "node:assert/strict";
import test from "node:test";

import { JobDataV1 } from "@ckb-automata/molecule";
import { hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import type { ResolvedLiveCell } from "./cancellation.ts";
import { createEpoch, parseHash32, parseOutPoint, type Hash32 } from "./chain-values.ts";
import {
  buildDaoHarvestPrepare,
  buildDaoHarvestRoll,
  buildDaoHarvestSetup,
  type DaoHarvestDeployment,
} from "./dao-harvest-builders.ts";
import { calculateDaoHarvestQuote } from "./dao-harvest-math.ts";
import { encodeAbsoluteEpochSince, encodeRelativeEpochSince } from "./triggers.ts";

const hash = (character: string) => parseHash32(`0x${character.repeat(64)}`);
const dep = (character: string) => ({
  outPoint: { txHash: hash(character), index: "0x0" as const },
  depType: "code" as const,
});
const contract = (character: string) => ({
  script: { codeHash: hash(character), hashType: "type" as const },
  cellDep: dep(character),
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
const ownerLock = { codeHash: hash("6"), hashType: "type" as const, args: "0x01" as const };
const payoutLock = { codeHash: hash("7"), hashType: "type" as const, args: "0x02" as const };
const executorLock = { codeHash: hash("8"), hashType: "type" as const, args: "0x03" as const };
const ownerLockHash = parseHash32(scriptToHash(ownerLock));
const payoutLockHash = parseHash32(scriptToHash(payoutLock));
const executorLockHash = parseHash32(scriptToHash(executorLock));
const PRINCIPAL = 10_000_000_000n;
const VAULT_OCCUPIED = 6_100_000_000n;
const JOB_OCCUPIED = 2_000_000_000n;
const REWARD = 100_000_000n;
const NETWORK_FEE = 1_000_000n;

function absoluteEpoch(number: bigint) {
  return encodeAbsoluteEpochSince(createEpoch({ number, index: 0n, length: 0n }));
}

function setup(cycles = 2n, principal = PRINCIPAL, reward = REWARD) {
  const actions = cycles * 2n;
  return buildDaoHarvestSetup({
    deployment,
    expectedGenesisHash: deployment.genesisHash,
    ownerLockHash,
    payoutLockHash,
    principal,
    vaultOccupiedCapacity: VAULT_OCCUPIED,
    jobOccupiedCapacity: JOB_OCCUPIED,
    prepareExecutorLockHashes: [executorLockHash],
    executorReward: reward,
    minCompensation: 1n,
    prepareBufferEpochs: encodeRelativeEpochSince(
      createEpoch({ number: 4n, index: 0n, length: 0n }),
    ),
    confirmationMarginEpochs: encodeRelativeEpochSince(
      createEpoch({ number: 1n, index: 0n, length: 0n }),
    ),
    totalCycles: cycles,
    endEpochSince: 0n,
    firstPrepareSince: absoluteEpoch(200n),
    creatorNonce: 9n,
    quote: calculateDaoHarvestQuote({
      principal,
      occupiedCapacity: VAULT_OCCUPIED,
      depositAccumulatedRate: 1_000n,
      projectedWithdrawAccumulatedRate: 1_100n,
      executorReward: reward,
      actions,
      estimatedNetworkFee: NETWORK_FEE,
      snapshotBlock: 100n,
      validUntilBlock: 110n,
    }),
    currentBlock: 105n,
  });
}

function point(txHash: Hash32, index: number) {
  return parseOutPoint({ txHash, index: BigInt(index) });
}

function key(outPoint: ReturnType<typeof point>) {
  return `${outPoint.txHash}:${outPoint.index}`;
}

function capacity(value: { readonly capacity: bigint | number | string }) {
  return BigInt(value.capacity);
}

function totalOutputs(transaction: ReturnType<typeof setup>["transaction"]) {
  return transaction.outputs.reduce((total, output) => total + capacity(output), 0n);
}

test("two linked harvest cycles conserve principal, budgets, compensation, and fees", async () => {
  const cells = new Map<string, ResolvedLiveCell>();
  const resolver = Object.freeze({
    resolve: async (outPoint: ReturnType<typeof point>) => cells.get(key(outPoint)) ?? null,
  });
  const publish = (
    txHash: Hash32,
    transaction: ReturnType<typeof setup>["transaction"],
    indexes: readonly number[],
  ) => {
    for (const index of indexes) {
      const outPoint = point(txHash, index);
      cells.set(
        key(outPoint),
        Object.freeze({
          outPoint,
          output: transaction.outputs[index]!,
          data: transaction.outputsData[index]!,
        }),
      );
    }
  };
  const inputTotal = (...outPoints: readonly ReturnType<typeof point>[]) =>
    outPoints.reduce((total, outPoint) => total + capacity(cells.get(key(outPoint))!.output), 0n);

  const initial = setup();
  const setupHash = hash("9");
  const authorityHash = hash("e");
  const setupVault = point(setupHash, 0);
  const setupJob = point(setupHash, 1);
  const initialAuthority = point(authorityHash, 0);
  publish(setupHash, initial.transaction, [0, 1]);
  cells.set(
    key(initialAuthority),
    Object.freeze({
      outPoint: initialAuthority,
      output: { capacity: 10_000_000_000n, lock: executorLock, type: null },
      data: "0x" as const,
    }),
  );

  const prepareOne = await buildDaoHarvestPrepare({
    deployment,
    expectedGenesisHash: deployment.genesisHash,
    resolver,
    vaultOutPoint: setupVault,
    jobOutPoint: setupJob,
    authorityOutPoint: initialAuthority,
    authorityLock: executorLock,
    authorityLockHash: executorLockHash,
    authorityOccupiedCapacity: VAULT_OCCUPIED,
    networkFee: NETWORK_FEE,
    payload: initial.payload,
    prepareExecutorLockHashes: [executorLockHash],
    depositHeaderHash: hash("f"),
    depositBlockNumber: 100n,
    claimSince: absoluteEpoch(380n),
  });
  assert.equal(
    totalOutputs(prepareOne.transaction),
    inputTotal(setupVault, setupJob, initialAuthority) - NETWORK_FEE,
  );
  assert.equal(capacity(prepareOne.transaction.outputs[0]!), PRINCIPAL);
  assert.equal(capacity(prepareOne.transaction.outputs[1]!), REWARD);
  assert.equal(
    JobDataV1.unpack(hexToBytes(prepareOne.transaction.outputsData[2]!)).remaining_runs.toString(),
    "3",
  );

  const prepareOneHash = hash("b");
  publish(prepareOneHash, prepareOne.transaction, [0, 2, 3]);
  const withdrawingOne = point(prepareOneHash, 0);
  const jobOne = point(prepareOneHash, 2);
  const authorityOne = point(prepareOneHash, 3);
  const rollOne = await buildDaoHarvestRoll({
    deployment,
    expectedGenesisHash: deployment.genesisHash,
    resolver,
    vaultOutPoint: withdrawingOne,
    jobOutPoint: jobOne,
    authorityOutPoint: authorityOne,
    authorityLock: executorLock,
    authorityLockHash: executorLockHash,
    authorityOccupiedCapacity: VAULT_OCCUPIED,
    networkFee: NETWORK_FEE,
    payload: initial.payload,
    prepareExecutorLockHashes: [executorLockHash],
    depositHeaderHash: hash("f"),
    prepareHeaderHash: hash("1"),
    depositAccumulatedRate: 1_000n,
    withdrawingAccumulatedRate: 1_100n,
    vaultOccupiedCapacity: VAULT_OCCUPIED,
    payoutOccupiedCapacity: 100_000_000n,
    nextPrepareSince: absoluteEpoch(560n),
    payoutLock,
    ownerRefundLock: ownerLock,
  });
  const compensationOne = BigInt(rollOne.intent["compensation"]!);
  assert.equal(compensationOne, 390_000_000n);
  assert.equal(
    totalOutputs(rollOne.transaction),
    inputTotal(withdrawingOne, jobOne, authorityOne) + compensationOne - NETWORK_FEE,
  );
  assert.equal(capacity(rollOne.transaction.outputs[0]!), PRINCIPAL);
  assert.equal(scriptToHash(rollOne.transaction.outputs[2]!.lock), payoutLockHash);

  const rollOneHash = hash("c");
  publish(rollOneHash, rollOne.transaction, [0, 3, 4]);
  const depositedTwo = point(rollOneHash, 0);
  const jobTwo = point(rollOneHash, 3);
  const authorityTwo = point(rollOneHash, 4);
  const prepareTwo = await buildDaoHarvestPrepare({
    deployment,
    expectedGenesisHash: deployment.genesisHash,
    resolver,
    vaultOutPoint: depositedTwo,
    jobOutPoint: jobTwo,
    authorityOutPoint: authorityTwo,
    authorityLock: executorLock,
    authorityLockHash: executorLockHash,
    authorityOccupiedCapacity: VAULT_OCCUPIED,
    networkFee: NETWORK_FEE,
    payload: initial.payload,
    prepareExecutorLockHashes: [executorLockHash],
    depositHeaderHash: hash("2"),
    depositBlockNumber: 200n,
    claimSince: absoluteEpoch(740n),
  });
  assert.equal(capacity(prepareTwo.transaction.outputs[0]!), PRINCIPAL);
  assert.equal(
    JobDataV1.unpack(hexToBytes(prepareTwo.transaction.outputsData[2]!)).remaining_runs.toString(),
    "1",
  );

  const prepareTwoHash = hash("d");
  publish(prepareTwoHash, prepareTwo.transaction, [0, 2, 3]);
  const withdrawingTwo = point(prepareTwoHash, 0);
  const finalJob = point(prepareTwoHash, 2);
  const finalAuthority = point(prepareTwoHash, 3);
  const rollTwo = await buildDaoHarvestRoll({
    deployment,
    expectedGenesisHash: deployment.genesisHash,
    resolver,
    vaultOutPoint: withdrawingTwo,
    jobOutPoint: finalJob,
    authorityOutPoint: finalAuthority,
    authorityLock: executorLock,
    authorityLockHash: executorLockHash,
    authorityOccupiedCapacity: VAULT_OCCUPIED,
    networkFee: NETWORK_FEE,
    payload: initial.payload,
    prepareExecutorLockHashes: [executorLockHash],
    depositHeaderHash: hash("2"),
    prepareHeaderHash: hash("3"),
    depositAccumulatedRate: 1_000n,
    withdrawingAccumulatedRate: 1_100n,
    vaultOccupiedCapacity: VAULT_OCCUPIED,
    payoutOccupiedCapacity: 100_000_000n,
    payoutLock,
    ownerRefundLock: ownerLock,
  });
  const compensationTwo = BigInt(rollTwo.intent["compensation"]!);
  assert.equal(
    totalOutputs(rollTwo.transaction),
    inputTotal(withdrawingTwo, finalJob, finalAuthority) + compensationTwo - NETWORK_FEE,
  );
  assert.equal(capacity(rollTwo.transaction.outputs[0]!), PRINCIPAL);
  assert.equal(scriptToHash(rollTwo.transaction.outputs[3]!.lock), ownerLockHash);
  assert.equal(capacity(rollTwo.transaction.outputs[3]!), JOB_OCCUPIED);
  assert.equal(rollTwo.intent["createsSuccessor"], false);
  assert.equal(compensationOne + compensationTwo, 780_000_000n);
});

test("setup accepts the exact minimum principal and maximum finite cycle count", () => {
  const minimum = setup(1n, VAULT_OCCUPIED, 1n);
  assert.equal(capacity(minimum.transaction.outputs[0]!), VAULT_OCCUPIED);

  const maximumCycles = 0x7fff_ffffn;
  const maximum = setup(maximumCycles, VAULT_OCCUPIED, 1n);
  const job = JobDataV1.unpack(hexToBytes(maximum.jobData));
  assert.equal(job.remaining_runs.toString(), (maximumCycles * 2n).toString());
  assert.equal(capacity(maximum.transaction.outputs[0]!), VAULT_OCCUPIED);
});
