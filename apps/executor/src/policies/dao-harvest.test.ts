import assert from "node:assert/strict";
import test from "node:test";

import { WitnessArgs } from "@ckb-ccc/shell";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import testnetManifest from "../../../../deploy/manifests/testnet.json" with { type: "json" };
import {
  DAO_HARVEST_JOB_OCCUPIED_CAPACITY,
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  buildDaoHarvestSetup,
  calculateDaoHarvestQuote,
  createDeploymentRegistry,
  createEpoch,
  encodeAbsoluteEpochSince,
  encodeRelativeEpochSince,
  hashDeploymentManifest,
  packEpoch,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseShannons,
  registeredDaoHarvestDeployment,
  toRpcHex,
  type ScriptIdentity,
} from "@ckb-automata/core";

import { ExecutorAdapterRegistry, runExecutorAdapter, type ExecutorSnapshot } from "../adapter.ts";
import { DAO_HARVEST_EXECUTOR_ADAPTER } from "./dao-harvest.ts";

const ownerLock: ScriptIdentity = {
  codeHash: parseHash32(`0x${"11".repeat(32)}`),
  hashType: "type",
  args: "0x1111",
};
const payoutLock: ScriptIdentity = {
  codeHash: parseHash32(`0x${"22".repeat(32)}`),
  hashType: "type",
  args: "0x2222",
};
const executorLock: ScriptIdentity = {
  codeHash: parseHash32(`0x${"33".repeat(32)}`),
  hashType: "type",
  args: "0x3333",
};

async function fixture() {
  const manifest = structuredClone(testnetManifest) as Record<string, unknown>;
  manifest["daoHarvest"] = {
    deployment: { transactionHash: `0x${"44".repeat(32)}`, blockHash: `0x${"45".repeat(32)}` },
    contracts: {
      "harvest-vault-lock": {
        codeHash: "0xa4693f462087a7e980817a7769224a11d1f4e3025f8aa97f1b49d724c4d7ae32",
        hashType: "data1",
        cellDep: {
          outPoint: { txHash: `0x${"44".repeat(32)}`, index: "0x0" },
          depType: "code",
        },
        binarySha256: "b543f869868c94bb56552f074c7d40ea32faf5b8ad1abd4b3e72d7c20f141b08",
        sizeBytes: 15_336,
      },
      "dao-harvest-policy": {
        codeHash: "0xa3ffba9aa6a33bc9cdbba5a6d9e9a103074fe2ae23635bc094c0bc214b01301c",
        hashType: "data1",
        cellDep: {
          outPoint: { txHash: `0x${"44".repeat(32)}`, index: "0x1" },
          depType: "code",
        },
        binarySha256: "9d8b781493c4cf8f8479468766a300d7cfef69495b830963a190203d7e5b6c69",
        sizeBytes: 41_304,
      },
    },
    nervosDao: {
      codeHash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
      hashType: "type",
      cellDep: {
        outPoint: {
          txHash: "0x8f8c79eb6671709633fe6a46de93c0fedc9c1b8a6527a18d3983879542635c9f",
          index: "0x2",
        },
        depType: "code",
      },
    },
    prepareExecutorLockHashes: [scriptToHash(executorLock)],
  };
  const registry = createDeploymentRegistry([
    {
      genesisHash: testnetManifest.genesisHash,
      manifestSha256: await hashDeploymentManifest(manifest),
      manifest,
      confirmationDepth: 5,
    },
  ]);
  const loaded = await registry.load(testnetManifest.genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("test deployment is unavailable");
  const deployment = registeredDaoHarvestDeployment(loaded.deployment);
  const reward = 61n * 100_000_000n;
  const principal = 1_000n * 100_000_000n;
  const setup = buildDaoHarvestSetup({
    deployment,
    expectedGenesisHash: loaded.deployment.genesisHash,
    ownerLockHash: parseHash32(scriptToHash(ownerLock)),
    payoutLockHash: parseHash32(scriptToHash(payoutLock)),
    principal,
    vaultOccupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
    jobOccupiedCapacity: DAO_HARVEST_JOB_OCCUPIED_CAPACITY,
    prepareExecutorLockHashes: [parseHash32(scriptToHash(executorLock))],
    executorReward: reward,
    minCompensation: 1n,
    prepareBufferEpochs: encodeRelativeEpochSince(
      createEpoch({ number: 4n, index: 0n, length: 0n }),
    ),
    confirmationMarginEpochs: encodeRelativeEpochSince(
      createEpoch({ number: 1n, index: 0n, length: 0n }),
    ),
    totalCycles: 1n,
    endEpochSince: 0n,
    firstPrepareSince: encodeAbsoluteEpochSince(
      createEpoch({ number: 200n, index: 0n, length: 0n }),
    ),
    creatorNonce: 1n,
    quote: calculateDaoHarvestQuote({
      principal,
      occupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
      depositAccumulatedRate: 1_000n,
      projectedWithdrawAccumulatedRate: 1_000n,
      executorReward: reward,
      actions: 2n,
      estimatedNetworkFee: 100_000_000n,
      snapshotBlock: 90n,
      validUntilBlock: 110n,
    }),
    currentBlock: 100n,
  });
  const vaultOutPoint = parseOutPoint({ txHash: `0x${"55".repeat(32)}`, index: "0" });
  const jobOutPoint = parseOutPoint({ txHash: `0x${"55".repeat(32)}`, index: "1" });
  const feeOutPoint = parseOutPoint({ txHash: `0x${"66".repeat(32)}`, index: "0" });
  const depositHash = parseHash32(`0x${"77".repeat(32)}`);
  const outputType = WitnessArgs.fromBytes(setup.transaction.witnesses[0]!).outputType;
  assert.ok(outputType);
  const snapshot: ExecutorSnapshot = Object.freeze({
    deployment: loaded.deployment,
    tip: Object.freeze({
      hash: parseHash32(`0x${"88".repeat(32)}`),
      number: parseBlockNumber(120n),
      epoch: `0x${packEpoch(createEpoch({ number: 200n, index: 0n, length: 0n })).toString(16)}`,
      timestamp: "0x0",
    }),
    job: Object.freeze({
      outPoint: jobOutPoint,
      output: setup.transaction.outputs[1]!,
      data: setup.jobData,
      blockHash: depositHash,
      blockNumber: parseBlockNumber(100n),
    }),
    applicationCells: Object.freeze([
      Object.freeze({
        outPoint: vaultOutPoint,
        output: setup.transaction.outputs[0]!,
        data: setup.transaction.outputsData[0]!,
        blockHash: depositHash,
        blockNumber: parseBlockNumber(100n),
      }),
    ]),
    feeCells: Object.freeze([
      Object.freeze({
        outPoint: feeOutPoint,
        output: Object.freeze({
          capacity: toRpcHex(parseShannons(100n * 100_000_000n)),
          lock: executorLock,
          type: null,
        }),
        data: "0x",
        blockHash: parseHash32(`0x${"99".repeat(32)}`),
        blockNumber: parseBlockNumber(110n),
      }),
    ]),
    headers: Object.freeze([]),
    resolvedLocks: Object.freeze([ownerLock, payoutLock, executorLock]),
    payloads: Object.freeze([outputType.toString() as `0x${string}`]),
    claims: Object.freeze({}),
  });
  return {
    snapshot,
    reward,
    deployment: loaded.deployment,
    payloadEnvelope: outputType.toString() as `0x${string}`,
  };
}

test("DAO harvest adapter reconstructs a deterministic preparation from live evidence", async () => {
  const { snapshot, reward } = await fixture();
  const result = await runExecutorAdapter(
    new ExecutorAdapterRegistry([DAO_HARVEST_EXECUTOR_ADAPTER]),
    snapshot,
    { rewardLock: executorLock, transactionFee: parseShannons("1000000") },
  );
  assert.equal(result.status, "built");
  if (result.status !== "built") return;
  assert.equal(result.adapterId, "dao-harvest-v1");
  assert.equal(result.build.transaction.inputs.length, 3);
  assert.equal(BigInt(result.build.transaction.outputs[1]!.capacity), reward);
  assert.equal(result.build.transaction.outputsData[0], "0x6400000000000000");
  assert.equal(result.build.summary["kind"], "prepare");
});

test("DAO harvest adapter fails closed after the safe preparation cutoff", async () => {
  const { snapshot } = await fixture();
  const result = await runExecutorAdapter(
    new ExecutorAdapterRegistry([DAO_HARVEST_EXECUTOR_ADAPTER]),
    {
      ...snapshot,
      tip: {
        ...snapshot.tip,
        epoch: `0x${packEpoch(createEpoch({ number: 203n, index: 0n, length: 0n })).toString(16)}`,
      },
    },
    { rewardLock: executorLock, transactionFee: parseShannons("1000000") },
  );
  assert.equal(result.status, "ineligible");
  if (result.status === "ineligible") {
    assert.equal(result.eligibility.reason, "EXECUTOR_PREPARE_WINDOW_MISSED");
  }
});

test("DAO harvest adapter claims compensation and re-deposits the exact principal", async () => {
  const initial = await fixture();
  const prepared = await runExecutorAdapter(
    new ExecutorAdapterRegistry([DAO_HARVEST_EXECUTOR_ADAPTER]),
    initial.snapshot,
    { rewardLock: executorLock, transactionFee: parseShannons("1000000") },
  );
  assert.equal(prepared.status, "built");
  if (prepared.status !== "built") return;
  const transaction = prepared.build.transaction;
  const prepareHash = parseHash32(`0x${"aa".repeat(32)}`);
  const depositHash = initial.snapshot.applicationCells[0]!.blockHash;
  const feeCell = initial.snapshot.feeCells[0]!;
  const rolling: ExecutorSnapshot = Object.freeze({
    deployment: initial.deployment,
    tip: Object.freeze({
      hash: parseHash32(`0x${"bb".repeat(32)}`),
      number: parseBlockNumber(140n),
      epoch: `0x${packEpoch(createEpoch({ number: 204n, index: 0n, length: 0n })).toString(16)}`,
      timestamp: "0x0",
      dao: `0x${"4c04000000000000"}${"00".repeat(24)}`,
    }),
    job: Object.freeze({
      outPoint: parseOutPoint({ txHash: prepareHash, index: "2" }),
      output: transaction.outputs[2]!,
      data: transaction.outputsData[2]!,
      blockHash: prepareHash,
      blockNumber: parseBlockNumber(130n),
    }),
    applicationCells: Object.freeze([
      Object.freeze({
        outPoint: parseOutPoint({ txHash: prepareHash, index: "0" }),
        output: transaction.outputs[0]!,
        data: transaction.outputsData[0]!,
        blockHash: prepareHash,
        blockNumber: parseBlockNumber(130n),
      }),
    ]),
    feeCells: Object.freeze([
      Object.freeze({
        ...feeCell,
        outPoint: parseOutPoint({ txHash: `0x${"cc".repeat(32)}`, index: "0" }),
      }),
    ]),
    headers: Object.freeze([
      Object.freeze({
        hash: depositHash,
        number: parseBlockNumber(100n),
        epoch: "0x0",
        timestamp: "0x0",
        dao: `0x${"e803000000000000"}${"00".repeat(24)}`,
      }),
      Object.freeze({
        hash: prepareHash,
        number: parseBlockNumber(130n),
        epoch: "0x0",
        timestamp: "0x0",
        dao: `0x${"4c04000000000000"}${"00".repeat(24)}`,
      }),
    ]),
    resolvedLocks: initial.snapshot.resolvedLocks,
    payloads: Object.freeze([initial.payloadEnvelope]),
    claims: Object.freeze({}),
  });
  const result = await runExecutorAdapter(
    new ExecutorAdapterRegistry([DAO_HARVEST_EXECUTOR_ADAPTER]),
    rolling,
    { rewardLock: executorLock, transactionFee: parseShannons("1000000") },
  );
  assert.equal(result.status, "built");
  if (result.status !== "built") return;
  assert.equal(result.build.summary["kind"], "claim_and_redeposit");
  assert.equal(
    BigInt(result.build.transaction.outputs[0]!.capacity),
    BigInt(initial.snapshot.applicationCells[0]!.output.capacity),
  );
  assert.deepEqual(result.build.transaction.outputs[2]?.lock, payoutLock);
  assert.deepEqual(result.build.transaction.outputs[3]?.lock, ownerLock);
});
