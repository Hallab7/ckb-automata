import assert from "node:assert/strict";
import test from "node:test";

import { parseDaoHarvestV3DeploymentManifest } from "./dao-harvest-v3-manifest.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}`;
const base = {
  schemaVersion: 3,
  releaseVersion: "0.3.0",
  network: "ckb_testnet",
  genesisHash: hash("1"),
  sourceRevision: "1".repeat(40),
  predecessorManifests: [],
  deployment: {
    transactionHash: hash("2"),
    blockHash: hash("3"),
    blockNumber: "0x10",
    confirmations: "5",
  },
  secp256k1Blake160: {
    codeHash: hash("4"),
    hashType: "type",
    cellDep: { outPoint: { txHash: hash("5"), index: "0x0" }, depType: "depGroup" },
  },
  nervosDao: {
    codeHash: hash("6"),
    hashType: "type",
    cellDep: { outPoint: { txHash: hash("7"), index: "0x2" }, depType: "code" },
  },
  contracts: Object.fromEntries(
    ["jobLock", "policy", "vaultLock", "compensationLock"].map((name, index) => [
      name,
      {
        codeHash: hash(["8", "9", "a", "b"][index]!),
        hashType: "data1",
        binarySha256: "a".repeat(64),
        sizeBytes: 1,
        cellDep: {
          outPoint: {
            txHash: hash(["8", "9", "a", "b"][index]!),
            index: `0x${index.toString(16)}`,
          },
          depType: "code",
        },
      },
    ]),
  ),
};

test("V3 API manifest requires canonical deployment evidence", () => {
  const parsed = parseDaoHarvestV3DeploymentManifest(base);
  assert.deepEqual(parsed.deployment, base.deployment);
  assert.throws(
    () => parseDaoHarvestV3DeploymentManifest({ ...base, deployment: undefined }),
    /deployment must be an object/,
  );
  assert.throws(
    () =>
      parseDaoHarvestV3DeploymentManifest({
        ...base,
        deployment: { ...base.deployment, confirmations: "0" },
      }),
    /deployment evidence/,
  );
});
