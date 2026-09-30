import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import testnetManifest from "../../../deploy/manifests/testnet.json" with { type: "json" };
import {
  createDeploymentRegistry,
  deploymentRegistry,
  hashDeploymentManifest,
  registeredDaoHarvestDeployment,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import { createApiApplication } from "./bootstrap.ts";
import {
  DAO_HARVEST_READ_STATES,
  DaoHarvestMutationService,
  DaoHarvestTransactionAdapter,
} from "./dao-harvest.ts";
import {
  DaoHarvestProjectionStore,
  extractDaoHarvestProjections,
} from "./indexer/dao-harvest-projection.ts";

const quietLogger: LoggerService = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

function environment() {
  return {
    AUTOMATA_PROFILE: "local",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: "0x5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3",
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

test("DAO harvest API publishes read, quote, and unsigned mutation routes", async () => {
  const { app } = await createApiApplication(environment(), { logger: quietLogger });
  try {
    await app.init();
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    for (const path of [
      "/v1/dao-harvest",
      "/v1/dao-harvest/{jobId}",
      "/v1/dao-harvest/{jobId}/quote",
      "/v1/dao-harvest/setup",
      "/v1/dao-harvest/stop",
      "/v1/dao-harvest/exit",
      "/v1/dao-harvest/recover",
    ]) {
      assert.ok(document.paths[path], `missing OpenAPI path ${path}`);
    }
    const schema = document.paths["/v1/dao-harvest/{jobId}"]?.get?.responses?.["200"];
    assert.match(JSON.stringify(schema), /principal/);
    assert.match(JSON.stringify(schema), /prepareStartSince/);
  } finally {
    await app.close();
  }
});

test("mutation service cannot sign, broadcast, or build before deployment registration", () => {
  const service = new DaoHarvestMutationService();
  assert.throws(() => service.build("setup", {}), /not deployed/);
  assert.deepEqual(DAO_HARVEST_READ_STATES, [
    "deposited",
    "withdrawing",
    "claim_ready",
    "completed",
    "recovery_required",
  ]);
});

test("active deployment builds an exact unsigned setup and rejects understated funding", async () => {
  const ownerLock = {
    codeHash: `0x${"01".repeat(32)}`,
    hashType: "type" as const,
    args: "0x1111" as const,
  };
  const payoutLock = {
    codeHash: `0x${"02".repeat(32)}`,
    hashType: "type" as const,
    args: "0x2222" as const,
  };
  const ownerLockHash = scriptToHash(ownerLock);
  const payoutLockHash = scriptToHash(payoutLock);
  const remembered: unknown[] = [];
  const manifest = structuredClone(testnetManifest) as Record<string, unknown>;
  manifest["daoHarvest"] = {
    deployment: { transactionHash: `0x${"b".repeat(64)}`, blockHash: `0x${"c".repeat(64)}` },
    contracts: {
      "harvest-vault-lock": {
        codeHash: "0xa4693f462087a7e980817a7769224a11d1f4e3025f8aa97f1b49d724c4d7ae32",
        hashType: "data1",
        cellDep: {
          outPoint: { txHash: `0x${"b".repeat(64)}`, index: "0x0" },
          depType: "code",
        },
        binarySha256: "b543f869868c94bb56552f074c7d40ea32faf5b8ad1abd4b3e72d7c20f141b08",
        sizeBytes: 15_336,
      },
      "dao-harvest-policy": {
        codeHash: "0xa3ffba9aa6a33bc9cdbba5a6d9e9a103074fe2ae23635bc094c0bc214b01301c",
        hashType: "data1",
        cellDep: {
          outPoint: { txHash: `0x${"b".repeat(64)}`, index: "0x1" },
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
    prepareExecutorLockHashes: [`0x${"d".repeat(64)}`],
  };
  const manifestSha256 = await hashDeploymentManifest(manifest);
  const registry = createDeploymentRegistry([
    {
      genesisHash: testnetManifest.genesisHash,
      manifestSha256,
      manifest,
      confirmationDepth: 5,
    },
  ]);
  const adapter = new DaoHarvestTransactionAdapter(
    {
      getTipHeader: async () =>
        ({
          dao: "0x7a14dc7d4756a958b57aabe58b5b2a003e230a79cfe5670a00fcfad744787909",
          epoch: BigInt("0x708064f00365d"),
          hash: `0x${"e".repeat(64)}`,
          number: 22_583_952n,
        }) as never,
    },
    testnetManifest.genesisHash,
    { remember: async (locks) => void remembered.push(...locks) },
    registry,
  );
  const result = await adapter.build("setup", {
    ownerLockHash,
    payoutLockHash,
    principal: "21000000000",
    totalCycles: 1,
    lockResolutions: [ownerLock, payoutLock],
  });
  const transaction = result.transaction as UnsignedDeadlineTransaction;
  assert.equal(result.operation, "setup");
  assert.match(result.jobId ?? "", /^0x[0-9a-f]{64}$/);
  assert.equal(transaction.inputs.length, 0);
  assert.equal(BigInt(transaction.outputs[0]!.capacity), 21_000_000_000n);
  assert.equal(BigInt(transaction.outputs[1]!.capacity), 50_300_000_000n);
  assert.equal(transaction.cellDeps.length, 5);
  assert.deepEqual(remembered, [ownerLock, payoutLock]);
  const registered = await registry.load(testnetManifest.genesisHash);
  assert.equal(registered.status, "ok");
  if (registered.status !== "ok") throw new Error("test deployment is unavailable");
  const projected = extractDaoHarvestProjections(
    {
      header: {
        epoch: BigInt("0x708064f00365d"),
        hash: `0x${"ab".repeat(32)}`,
        number: 22_583_953n,
      },
      transactions: [
        {
          hash: () => `0x${"cd".repeat(32)}`,
          outputs: transaction.outputs.map((output) => ({
            ...output,
            capacity: BigInt(output.capacity),
            type: output.type ?? undefined,
          })),
          outputsData: transaction.outputsData,
          witnesses: transaction.witnesses,
        },
      ],
    } as never,
    registeredDaoHarvestDeployment(registered.deployment),
  );
  assert.equal(projected.malformed, 0);
  assert.equal(projected.projections.length, 1);
  assert.equal(projected.projections[0]?.jobId, result.jobId);
  assert.equal(projected.projections[0]?.principalCapacity, 21_000_000_000n);
  assert.equal(projected.projections[0]?.vaultState, "deposited");
  await assert.rejects(
    adapter.build("setup", {
      ownerLockHash,
      payoutLockHash,
      principal: "20999999999",
      totalCycles: 1,
      lockResolutions: [ownerLock, payoutLock],
    }),
    /at least 210 CKB/,
  );
  await assert.rejects(
    adapter.build("setup", {
      ownerLockHash,
      payoutLockHash,
      principal: "21000000000",
      totalCycles: 1,
      lockResolutions: [ownerLock, payoutLock],
      extra: true,
    }),
    /unsupported fields/,
  );
});

test("DAO harvest consumption discovery uses one candidate query per block", async () => {
  const registered = await deploymentRegistry.load(testnetManifest.genesisHash);
  assert.equal(registered.status, "ok");
  if (registered.status !== "ok") throw new Error("testnet deployment is unavailable");

  let candidateQueries = 0;
  let transactions = 0;
  const database = {
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
      transactions += 1;
      return callback({
        execute: async () => undefined,
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: async () => {
                candidateQueries += 1;
                return [];
              },
            }),
          }),
        }),
      });
    },
  };
  const inputs = Array.from({ length: 50 }, (_, index) => ({
    previousOutput: {
      txHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      index: BigInt(index % 2),
    },
  }));
  const result = await new DaoHarvestProjectionStore(database as never).projectBlock(
    {
      header: {
        epoch: 0n,
        hash: `0x${"ab".repeat(32)}`,
        number: 22_584_000n,
      },
      transactions: [
        {
          hash: () => `0x${"cd".repeat(32)}`,
          inputs,
          outputs: [],
          outputsData: [],
          witnesses: [],
        },
      ],
    } as never,
    registered.deployment,
  );

  assert.equal(result.persisted, 0);
  assert.equal(transactions, 1);
  assert.equal(candidateQueries, 1);
});
