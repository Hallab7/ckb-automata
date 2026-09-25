import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ClientBlock } from "@ckb-ccc/shell";

import { deploymentRegistry } from "@ckb-automata/core";

import { extractSupportedJobCells, JobCellDiscovery } from "./job-discovery.ts";

const manifest = JSON.parse(
  await readFile(new URL("../../../../deploy/manifests/local.json", import.meta.url), "utf8"),
) as { genesisHash: string };
const fixture = JSON.parse(
  await readFile(
    new URL("../../../../contracts/fixtures/recurring_creation_v1.json", import.meta.url),
    "utf8",
  ),
) as {
  expected: { job_data: `0x${string}`; job_id: string; policy_script_hash: string };
  owner_lock_hash: string;
};
const loaded = await deploymentRegistry.load(manifest.genesisHash);
if (loaded.status !== "ok") throw new Error("local deployment fixture is unavailable");
const deployment = loaded.deployment;

function version(value: `0x${string}`, replacement: string): `0x${string}` {
  return `0x${value.slice(2, 130)}${replacement}${value.slice(134)}`;
}

function block(data: readonly `0x${string}`[]): ClientBlock {
  const jobLock = { ...deployment.contracts["job-lock"].script, args: "0x" };
  const policy = { ...deployment.contracts["recurring-policy"].script, args: "0x" };
  return {
    header: {
      number: 42n,
      hash: `0x${"42".repeat(32)}`,
      timestamp: 1_800_000_000_000n,
    },
    transactions: [
      {
        hash: () => `0x${"33".repeat(32)}`,
        outputs: data.map(() => ({ capacity: 20_000_000_000n, lock: jobLock, type: policy })),
        outputsData: [...data],
      },
    ],
  } as unknown as ClientBlock;
}

test("extracts supported Job Lock outputs with source and block provenance", () => {
  const result = extractSupportedJobCells(block([fixture.expected.job_data]), deployment);
  assert.equal(result.jobLockOutputs, 1);
  assert.equal(result.cells.length, 1);
  assert.deepEqual(result.cells[0], {
    networkId: "ckb_dev",
    jobId: fixture.expected.job_id,
    sequence: 0n,
    ownerLockHash: fixture.owner_lock_hash,
    policyScriptHash: fixture.expected.policy_script_hash,
    policyKind: "recurring",
    capacity: 20_000_000_000n,
    data: fixture.expected.job_data,
    outPoint: { txHash: `0x${"33".repeat(32)}`, index: 0n },
    provenance: {
      blockNumber: 42n,
      blockHash: `0x${"42".repeat(32)}`,
      transactionIndex: 0n,
      timestamp: 1_800_000_000_000n,
    },
  });
});

test("counts malformed and unsupported JobData without projecting it", () => {
  const result = extractSupportedJobCells(
    block(["0x1234", version(fixture.expected.job_data, "0200")]),
    deployment,
  );
  assert.equal(result.jobLockOutputs, 2);
  assert.equal(result.malformedOrInvalid, 1);
  assert.equal(result.unsupportedVersions, 1);
  assert.equal(result.cells.length, 0);
});

test("skips database work when a block has no supported Job Cells", async () => {
  let transactionCalled = false;
  const discovery = new JobCellDiscovery(
    {
      transaction: async () => {
        transactionCalled = true;
        throw new Error("empty blocks must not open a transaction");
      },
    } as never,
    {} as never,
  );
  const result = await discovery.projectBlock(block(["0x1234"]), deployment);
  assert.equal(transactionCalled, false);
  assert.equal(result.insertedJobs, 0);
  assert.equal(result.existingJobs, 0);
});
