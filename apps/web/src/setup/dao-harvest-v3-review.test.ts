import assert from "node:assert/strict";
import test from "node:test";
import type { ApiDaoHarvestV3Build } from "@ckb-automata/api-client";
import {
  daoHarvestV3ReviewSnapshot,
  normalizeDaoHarvestV3Build,
  verifyDaoHarvestV3SignerChain,
  verifyRefreshedDaoHarvestV3Build,
} from "./dao-harvest-v3-review.ts";

const hash = (value: string) => `0x${value.repeat(64)}`;
const build = (): ApiDaoHarvestV3Build => ({
  version: 3,
  jobId: hash("1"),
  operation: "owner-exit",
  intentHash: hash("2"),
  chain: {
    genesisHash: hash("a"),
    manifestSha256: "b".repeat(64),
  },
  transaction: {
    version: "0x0",
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  },
  review: {
    protectedAmount: "100",
    maximumNetworkFee: "10",
    totalInput: "110",
    totalOutput: "100",
  },
  completion: {
    requiredInputCount: 0,
    requiredOutputCount: 0,
    requiredInputCapacity: "110",
    maximumFee: "10",
    allowedFundingLockHashes: [hash("3")],
    protectedSameIndex: 1,
  },
});

test("normalizes the closed V3 review contract", () => {
  const normalized = normalizeDaoHarvestV3Build(build());
  assert.equal(normalized.operation, 9);
  assert.equal(normalized.completion.protectedSameIndex, 1);
  assert.equal(normalized.value.maximumNetworkFee, 10n);
});

test("a refreshed V3 review must preserve the exact intent", () => {
  const reviewed = build();
  verifyRefreshedDaoHarvestV3Build(reviewed, structuredClone(reviewed));
  assert.throws(
    () => verifyRefreshedDaoHarvestV3Build(reviewed, { ...reviewed, intentHash: hash("9") }),
    /review changed/,
  );
  assert.throws(
    () =>
      verifyRefreshedDaoHarvestV3Build(reviewed, {
        ...reviewed,
        chain: { ...reviewed.chain, manifestSha256: "c".repeat(64) },
      }),
    /review changed/,
  );
});

test("the signer, API build, and approved testnet must share one genesis", () => {
  const reviewed = build();
  assert.doesNotThrow(() =>
    verifyDaoHarvestV3SignerChain(reviewed, reviewed.chain.genesisHash, reviewed.chain.genesisHash),
  );
  assert.throws(
    () => verifyDaoHarvestV3SignerChain(reviewed, hash("9"), reviewed.chain.genesisHash),
    /reviewed CKB testnet/,
  );
  assert.throws(
    () => verifyDaoHarvestV3SignerChain(reviewed, reviewed.chain.genesisHash, hash("9")),
    /reviewed CKB testnet/,
  );
});

test("V3 review snapshots bind chain identity and remain bounded", () => {
  assert.deepEqual(
    daoHarvestV3ReviewSnapshot({ blockHash: hash("4"), blockNumber: "10" }, build().chain),
    {
      blockHash: hash("4"),
      blockNumber: "10",
      genesisHash: hash("a"),
      manifestSha256: "b".repeat(64),
      expiresAfterBlock: "40",
    },
  );
  assert.throws(() =>
    daoHarvestV3ReviewSnapshot({ blockHash: hash("4"), blockNumber: "010" }, build().chain),
  );
});
