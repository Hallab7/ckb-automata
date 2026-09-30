import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDaoHarvestSetup,
  calculateDaoHarvestQuote,
  createEpoch,
  encodeAbsoluteEpochSince,
  encodeRelativeEpochSince,
  parseHash32,
  scriptIdentityHash,
} from "../packages/core/src/index.ts";
import { executeRecoveryCli } from "./recovery-cli-lib.mjs";

const hash = (character) => parseHash32(`0x${character.repeat(64)}`);
const dep = (character) => ({
  outPoint: { txHash: hash(character), index: "0x0" },
  depType: "code",
});
const contract = (character) => ({
  script: { codeHash: hash(character), hashType: "type" },
  cellDep: dep(character),
});
const deployment = {
  network: "ckb_testnet",
  genesisHash: hash("a"),
  manifestSha256: "b".repeat(64),
  secp256k1Blake160: { cellDep: dep("1") },
  jobLock: contract("2"),
  policy: contract("3"),
  vaultLock: contract("4"),
  daoType: contract("5"),
};
const ownerLock = { codeHash: hash("1"), hashType: "type", args: "0x1234" };
const ownerLockHash = scriptIdentityHash(ownerLock);
const setup = buildDaoHarvestSetup({
  deployment,
  expectedGenesisHash: deployment.genesisHash,
  ownerLockHash,
  payoutLockHash: hash("7"),
  principal: 10_000_000_000n,
  vaultOccupiedCapacity: 6_100_000_000n,
  jobOccupiedCapacity: 2_000_000_000n,
  prepareExecutorLockHashes: [hash("8")],
  executorReward: 100_000_000n,
  minCompensation: 1n,
  prepareBufferEpochs: encodeRelativeEpochSince(createEpoch({ number: 4n, index: 0n, length: 0n })),
  confirmationMarginEpochs: encodeRelativeEpochSince(
    createEpoch({ number: 1n, index: 0n, length: 0n }),
  ),
  totalCycles: 1n,
  endEpochSince: encodeAbsoluteEpochSince(createEpoch({ number: 600n, index: 0n, length: 0n })),
  firstPrepareSince: encodeAbsoluteEpochSince(createEpoch({ number: 200n, index: 0n, length: 0n })),
  creatorNonce: 1n,
  quote: calculateDaoHarvestQuote({
    principal: 10_000_000_000n,
    occupiedCapacity: 6_100_000_000n,
    depositAccumulatedRate: 1_000n,
    projectedWithdrawAccumulatedRate: 1_100n,
    executorReward: 100_000_000n,
    actions: 2n,
    estimatedNetworkFee: 1_000n,
    snapshotBlock: 100n,
    validUntilBlock: 110n,
  }),
  currentBlock: 105n,
});

test("harvest recovery planner covers hosted outages and mature withdrawals", async () => {
  const deposited = await executeRecoveryCli([
    "harvest-plan",
    "--condition",
    "service_unavailable",
    "--vault-state",
    "deposited",
  ]);
  assert.equal(deposited.plan.primaryAction, "start_owner_exit");
  const mature = await executeRecoveryCli([
    "harvest-plan",
    "--condition",
    "deprecated",
    "--vault-state",
    "withdrawing",
    "--claim-mature",
  ]);
  assert.equal(mature.plan.primaryAction, "claim_mature_vault");
  assert.equal(mature.plan.hostedServicesRequired, false);
});

test("harvest mature recovery exports an unsigned owner-only artifact using public RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ckb-automata-harvest-recovery-"));
  try {
    const deploymentPath = join(directory, "deployment.json");
    const ownerPath = join(directory, "owner.json");
    const outputPath = join(directory, "unsigned.json");
    await writeFile(deploymentPath, JSON.stringify(deployment));
    await writeFile(ownerPath, JSON.stringify(ownerLock));
    const vaultHash = hash("c");
    const ownerHash = hash("d");
    const fetchImpl = async (_url, request) => {
      const body = JSON.parse(request.body);
      let result;
      if (body.method === "get_block_hash") result = deployment.genesisHash;
      if (body.method === "get_tip_header") result = { epoch: "0x17c" };
      if (body.method === "get_header") {
        const rate = body.params[0] === hash("e") ? "e803000000000000" : "4c04000000000000";
        result = { dao: `0x${"00".repeat(8)}${rate}${"00".repeat(16)}` };
      }
      if (body.method === "get_live_cell") {
        const txHash = body.params[0].tx_hash;
        const output =
          txHash === vaultHash
            ? setup.transaction.outputs[0]
            : { capacity: "0x1a13b8600", lock: ownerLock, type: null };
        result = {
          status: "live",
          cell: {
            output: {
              capacity: output.capacity,
              lock: {
                code_hash: output.lock.codeHash,
                hash_type: output.lock.hashType,
                args: output.lock.args,
              },
              type:
                output.type === null
                  ? null
                  : {
                      code_hash: output.type.codeHash,
                      hash_type: output.type.hashType,
                      args: output.type.args,
                    },
            },
            data: { content: txHash === vaultHash ? "0x6400000000000000" : "0x" },
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { id: body.id, jsonrpc: "2.0", result };
        },
      };
    };
    const claimSince = encodeAbsoluteEpochSince(
      createEpoch({ number: 380n, index: 0n, length: 0n }),
    );
    const result = await executeRecoveryCli(
      [
        "harvest-export",
        "--harvest-deployment",
        deploymentPath,
        "--rpc-url",
        "https://testnet.ckb.example",
        "--owner-lock",
        ownerPath,
        "--owner-out-point",
        `${ownerHash}:0x0`,
        "--vault-out-point",
        `${vaultHash}:0x0`,
        "--operation",
        "mature-recovery",
        "--deposit-header",
        hash("e"),
        "--prepare-header",
        hash("f"),
        "--vault-occupied-capacity",
        "6100000000",
        "--claim-since",
        claimSince.toString(),
        "--output",
        outputPath,
      ],
      { fetchImpl },
    );
    assert.equal(result.operation, "mature-recovery");
    const artifact = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(artifact.schema, "ckb-automata/dao-harvest-recovery/v1");
    assert.equal(artifact.intent.kind, "mature_recovery");
    assert.equal(artifact.transaction.inputs.length, 2);
    assert.equal(artifact.transaction.outputs[0].lock.args, ownerLock.args);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
