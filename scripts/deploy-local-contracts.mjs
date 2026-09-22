/* global fetch */

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";

import { CampaignDataV1 } from "../packages/molecule/src/generated/campaign_v1.ts";
import {
  LOCAL_LOCK_ARG,
  ckbHash,
  concatBytes,
  discoverGenesis,
  littleEndian,
  occupiedShannons,
  signSingleInput,
  toRpcTransaction,
} from "./lib/ckb-local.mjs";

const root = new URL("../", import.meta.url);
const rpcUrl = process.env.CKB_RPC_URL ?? "http://127.0.0.1:58114";
const composeFile = fileURLToPath(new URL("deploy/docker/compose.yml", root));
const artifactRoot = new URL("target/contract-artifacts/", root);
const deploymentManifestUrl = new URL("deploy/manifests/local.json", root);
const transactionFee = 1_000_000n;
let rpcId = 0;

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: ++rpcId, jsonrpc: "2.0", method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(`${method}: ${payload.error?.message ?? `HTTP ${response.status}`}`);
  }
  return payload.result;
}

async function waitForRpc() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await rpc("get_tip_header");
    } catch {
      await delay(500);
    }
  }
  throw new Error(`CKB RPC did not become ready at ${rpcUrl}`);
}

function mineBlocks(count = 20) {
  execFileSync(
    "docker",
    [
      "compose",
      "--file",
      composeFile,
      "exec",
      "--no-TTY",
      "ckb",
      "ckb",
      "miner",
      "-C",
      "/var/lib/ckb",
      "--limit",
      String(count),
    ],
    { stdio: "inherit" },
  );
}

async function waitForCommitted(txHash) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const transaction = await rpc("get_transaction", [txHash]);
    if (transaction?.tx_status?.status === "committed") return transaction.tx_status.block_hash;
    if (transaction?.tx_status?.status === "rejected") {
      throw new Error(`${txHash} was rejected: ${transaction.tx_status.reason}`);
    }
    await delay(250);
  }
  throw new Error(`${txHash} was not committed after mining`);
}

async function readExistingManifest() {
  try {
    return JSON.parse(await readFile(deploymentManifestUrl, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function verifyExistingDeployment(manifest, artifactManifest, genesisHash) {
  if (!manifest || manifest.genesisHash !== genesisHash) return false;
  const expectedBinaries = new Map(
    artifactManifest.binaries.map((binary) => [binary.name, binary.sha256]),
  );
  for (const [name, contract] of Object.entries(manifest.contracts ?? {})) {
    if (expectedBinaries.get(name) !== contract.binarySha256) {
      throw new Error(
        "the local chain contains different contract artifacts; reset its dedicated volume before redeploying",
      );
    }
    const liveCell = await rpc("get_live_cell", [
      {
        tx_hash: contract.cellDep.outPoint.txHash,
        index: contract.cellDep.outPoint.index,
      },
      false,
    ]);
    if (liveCell.status !== "live") return false;
  }
  if (expectedBinaries.size !== Object.keys(manifest.contracts ?? {}).length) return false;
  const deployment = await rpc("get_transaction", [manifest.deployment.transactionHash]);
  const verification = await rpc("get_transaction", [manifest.verification.transactionHash]);
  if (
    deployment?.tx_status?.status !== "committed" ||
    verification?.tx_status?.status !== "committed"
  ) {
    return false;
  }
  console.log(`Reused committed deployment ${manifest.deployment.transactionHash}`);
  console.log(`Verified committed contract execution ${manifest.verification.transactionHash}`);
  return true;
}

function hex(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function rpcCapacity(value) {
  return `0x${value.toString(16)}`;
}

function makeTransaction({ cellDeps, input, outputs, outputsData, witness }) {
  return signSingleInput(
    {
      version: "0x0",
      cellDeps,
      headerDeps: [],
      inputs: [{ since: "0x0", previousOutput: input }],
      outputs,
      outputsData,
      witnesses: [],
    },
    witness,
  );
}

await waitForRpc();
const genesisBlock = await rpc("get_block_by_number", ["0x0"]);
const genesisHash = genesisBlock.header.hash;
const genesis = discoverGenesis(genesisBlock);
const artifactManifest = JSON.parse(await readFile(new URL("manifest.json", artifactRoot), "utf8"));
if (artifactManifest.sourceDirty) {
  throw new Error(
    "contract artifacts came from a dirty source tree; rebuild them before deployment",
  );
}
if (await verifyExistingDeployment(await readExistingManifest(), artifactManifest, genesisHash)) {
  process.exit(0);
}

const binaries = await Promise.all(
  artifactManifest.binaries.map(async (artifact) => {
    const data = new Uint8Array(await readFile(new URL(artifact.file, artifactRoot)));
    if (data.length !== artifact.sizeBytes)
      throw new Error(`${artifact.name} artifact size changed`);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sha256 !== artifact.sha256) throw new Error(`${artifact.name} artifact hash changed`);
    return { ...artifact, data, codeHash: ckbHash(data) };
  }),
);

const codeOutputs = binaries.map(({ data }) => {
  const output = { capacity: "0x0", lock: genesis.lock, type: null };
  return { ...output, capacity: rpcCapacity(occupiedShannons(output, data)) };
});
const fundingCapacity = BigInt(genesis.funding.capacity);
const codeCapacity = codeOutputs.reduce((total, output) => total + BigInt(output.capacity), 0n);
const deployChangeCapacity = fundingCapacity - codeCapacity - transactionFee;
if (deployChangeCapacity <= occupiedShannons({ lock: genesis.lock, type: null }, "0x")) {
  throw new Error("genesis funding cell cannot cover contract deployment");
}

const deployTransaction = makeTransaction({
  cellDeps: [genesis.secpCellDep],
  input: { txHash: genesis.funding.txHash, index: genesis.funding.index },
  outputs: [
    ...codeOutputs,
    { capacity: rpcCapacity(deployChangeCapacity), lock: genesis.lock, type: null },
  ],
  outputsData: [...binaries.map(({ data }) => hex(data)), "0x"],
  witness: { lock: "", inputType: "", outputType: "" },
});
const deployTxHash = await rpc("send_transaction", [toRpcTransaction(deployTransaction)]);
mineBlocks();
const deployBlockHash = await waitForCommitted(deployTxHash);

const campaign = binaries.find(({ name }) => name === "demo-campaign-type");
if (!campaign) throw new Error("demo campaign contract artifact is missing");
const campaignLock = binaries.find(({ name }) => name === "campaign-lock");
if (!campaignLock) throw new Error("campaign lock artifact is missing");
const campaignId = new Uint8Array(32).fill(0x11);
const records = concatBytes(
  new Uint8Array(32).fill(0x01),
  littleEndian(0, 4),
  new Uint8Array(32).fill(0x51),
  littleEndian(4_000_000_000n, 8),
  new Uint8Array(32).fill(0x02),
  littleEndian(1, 4),
  new Uint8Array(32).fill(0x52),
  littleEndian(6_000_000_000n, 8),
);
const refundBody = concatBytes(littleEndian(2, 4), records);
const refundCommitment = ckbHash(
  concatBytes(
    new TextEncoder().encode("ckb-automata/campaign-refunds/v1"),
    new Uint8Array([0]),
    littleEndian(refundBody.length, 4),
    refundBody,
  ),
);
const campaignData = CampaignDataV1.pack({
  version: 1,
  state: 0,
  campaign_id: [...campaignId],
  pledged: "10000000000",
  pledge_count: 2,
  target: "15000000000",
  deadline_since: "42",
  success_lock_hash: Array.from({ length: 32 }, () => 0x22),
  refund_commitment: [...Buffer.from(refundCommitment.slice(2), "hex")],
});
const campaignType = { codeHash: campaign.codeHash, hashType: "data1", args: hex(campaignId) };
const campaignLockScript = { codeHash: campaignLock.codeHash, hashType: "data1", args: "0x" };
const campaignOutputBase = { capacity: "0x0", lock: campaignLockScript, type: campaignType };
const campaignCapacity = occupiedShannons(campaignOutputBase, campaignData) + 10_000_000_000n;
const campaignChange = deployChangeCapacity - campaignCapacity - transactionFee;
const campaignTransaction = makeTransaction({
  cellDeps: [
    genesis.secpCellDep,
    {
      outPoint: { txHash: deployTxHash, index: `0x${binaries.indexOf(campaign).toString(16)}` },
      depType: "code",
    },
    {
      outPoint: {
        txHash: deployTxHash,
        index: `0x${binaries.indexOf(campaignLock).toString(16)}`,
      },
      depType: "code",
    },
  ],
  input: { txHash: deployTxHash, index: `0x${binaries.length.toString(16)}` },
  outputs: [
    { ...campaignOutputBase, capacity: rpcCapacity(campaignCapacity) },
    { capacity: rpcCapacity(campaignChange), lock: genesis.lock, type: null },
  ],
  outputsData: [hex(campaignData), "0x"],
  witness: { lock: "", inputType: "", outputType: hex(records) },
});
const verificationTxHash = await rpc("send_transaction", [toRpcTransaction(campaignTransaction)]);
mineBlocks();
const verificationBlockHash = await waitForCommitted(verificationTxHash);
const nodeVersion = await rpc("local_node_info");

const manifest = {
  schemaVersion: 1,
  network: "ckb_dev",
  rpcUrl,
  genesisHash,
  consensus: { hardfork: "ckb2023", activationEpoch: 0 },
  nodeVersion: nodeVersion.version,
  fixtureWallet: { lockArg: LOCAL_LOCK_ARG, warning: "Public local-development fixture only" },
  artifacts: {
    sourceRevision: artifactManifest.sourceRevision,
    schemaSha256: artifactManifest.schema.aggregateSha256,
    builder: artifactManifest.builder,
  },
  secp256k1Blake160: {
    codeHash: genesis.lock.codeHash,
    hashType: genesis.lock.hashType,
    cellDep: genesis.secpCellDep,
  },
  deployment: { transactionHash: deployTxHash, blockHash: deployBlockHash },
  contracts: Object.fromEntries(
    binaries.map((binary, index) => [
      binary.name,
      {
        codeHash: binary.codeHash,
        hashType: "data1",
        cellDep: {
          outPoint: { txHash: deployTxHash, index: `0x${index.toString(16)}` },
          depType: "code",
        },
        binarySha256: binary.sha256,
        sizeBytes: binary.sizeBytes,
      },
    ]),
  ),
  verification: {
    kind: "campaign-creation",
    transactionHash: verificationTxHash,
    blockHash: verificationBlockHash,
    contract: "demo-campaign-type",
    status: "committed",
  },
};
await writeFile(deploymentManifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Deployed ${binaries.length} contracts in ${deployTxHash}`);
console.log(`Verified deployed campaign contract in ${verificationTxHash}`);
console.log(`Local manifest written to ${fileURLToPath(deploymentManifestUrl)}`);
