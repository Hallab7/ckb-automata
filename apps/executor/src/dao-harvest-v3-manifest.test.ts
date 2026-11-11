import assert from "node:assert/strict";
import test from "node:test";

import { parseDaoHarvestV3ExecutorManifest } from "./dao-harvest-v3-manifest.ts";

test("hosted executor accepts schema-3 manifests and rejects unaudited metadata", () => {
  const base = {
    schemaVersion: 3,
    releaseVersion: "0.2.0",
    network: "ckb_testnet",
    genesisHash: `0x${"1".repeat(64)}`,
    sourceRevision: "1".repeat(40),
    predecessorManifests: [],
    secp256k1Blake160: {
      codeHash: `0x${"2".repeat(64)}`,
      hashType: "type",
      cellDep: { outPoint: { txHash: `0x${"3".repeat(64)}`, index: "0x0" }, depType: "depGroup" },
    },
    nervosDao: {
      codeHash: `0x${"4".repeat(64)}`,
      hashType: "type",
      cellDep: { outPoint: { txHash: `0x${"5".repeat(64)}`, index: "0x0" }, depType: "code" },
    },
    contracts: Object.fromEntries(
      ["jobLock", "policy", "vaultLock", "compensationLock"].map((name, index) => [
        name,
        {
          codeHash: `0x${String(index + 6).repeat(64)}`,
          hashType: "data1",
          binarySha256: "a".repeat(64),
          sizeBytes: 1,
          cellDep: {
            outPoint: { txHash: `0x${String(index + 6).repeat(64)}`, index: "0x0" },
            depType: "code",
          },
        },
      ]),
    ),
  };
  const parsed = parseDaoHarvestV3ExecutorManifest(base);
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.contracts.jobLock.hashType, "data1");
  assert.throws(
    () =>
      parseDaoHarvestV3ExecutorManifest({
        ...base,
        contracts: {
          ...base.contracts,
          policy: { ...base.contracts["policy"], binarySha256: "not-a-digest" },
        },
      }),
    /audit metadata/,
  );
});
