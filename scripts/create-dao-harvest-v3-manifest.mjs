/* global fetch */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ckbHash } from "./lib/ckb-local.mjs";

const root = new URL("../", import.meta.url);
const HASH = /^0x[0-9a-f]{64}$/;
const RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const CONTRACTS = Object.freeze([
  ["jobLock", "dao-harvest-job-lock-v3", "0x0"],
  ["policy", "dao-harvest-policy-v3", "0x1"],
  ["vaultLock", "harvest-vault-lock-v3", "0x2"],
  ["compensationLock", "compensation-lock-v3", "0x3"],
]);
const ZERO_LOCK = Object.freeze({
  args: "0x",
  code_hash: `0x${"00".repeat(32)}`,
  hash_type: "data1",
});

export function parseDaoHarvestV3ManifestArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("arguments must be --name value pairs");
    }
    if (!["--transaction-hash", "--release-version", "--output", "--rpc-url"].includes(flag)) {
      throw new Error(`unsupported argument: ${flag}`);
    }
    result[flag.slice(2)] = value;
  }
  if (!HASH.test(result["transaction-hash"] ?? ""))
    throw new Error("--transaction-hash must be a lowercase CKB transaction hash");
  if (!RELEASE.test(result["release-version"] ?? ""))
    throw new Error("--release-version must be MAJOR.MINOR.PATCH");
  const expectedName = `dao-harvest-v3-testnet-v${result["release-version"]}.json`;
  const output = resolve(fileURLToPath(root), result.output ?? `deploy/manifests/${expectedName}`);
  if (basename(output) !== expectedName) {
    throw new Error(`--output must end with ${expectedName}`);
  }
  return Object.freeze({
    transactionHash: result["transaction-hash"],
    releaseVersion: result["release-version"],
    output,
    rpcUrl: result["rpc-url"],
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(`${method} failed while verifying the deployment`);
  }
  return payload.result;
}

export async function createDaoHarvestV3Manifest(options) {
  const [publicManifest, artifactManifest] = await Promise.all([
    readFile(new URL("deploy/manifests/testnet.json", root), "utf8").then(JSON.parse),
    readFile(new URL("target/contract-artifacts/manifest.json", root), "utf8").then(JSON.parse),
  ]);
  if (artifactManifest.sourceDirty === true) {
    throw new Error("contract artifacts were built from a dirty source tree");
  }
  const git = process.platform === "win32" ? "git.exe" : "git";
  const sourceRevision = execFileSync(git, ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  }).trim();
  if (artifactManifest.sourceRevision !== sourceRevision) {
    throw new Error("contract artifacts do not match the current source revision");
  }
  const rpcUrl = options.rpcUrl ?? publicManifest.rpcUrl;
  const [genesis, transaction, tip] = await Promise.all([
    rpc(rpcUrl, "get_block_by_number", ["0x0"]),
    rpc(rpcUrl, "get_transaction", [options.transactionHash]),
    rpc(rpcUrl, "get_tip_header"),
  ]);
  assert.equal(genesis.header.hash, publicManifest.genesisHash, "CKB testnet genesis mismatch");
  assert.equal(transaction.tx_status.status, "committed", "deployment is not committed");
  assert.ok(transaction.tx_status.block_hash, "deployment has no canonical block hash");
  const block = await rpc(rpcUrl, "get_header", [transaction.tx_status.block_hash]);
  const confirmations = BigInt(tip.number) - BigInt(block.number) + 1n;
  const requiredConfirmations = BigInt(process.env.DEPLOYMENT_CONFIRMATIONS ?? "5");
  assert.ok(requiredConfirmations >= 5n, "deployment confirmation policy cannot be lower than 5");
  assert.ok(
    confirmations >= requiredConfirmations,
    `deployment has ${confirmations} confirmations; ${requiredConfirmations} required`,
  );
  const contracts = {};
  for (const [key, binaryName, index] of CONTRACTS) {
    const position = Number(BigInt(index));
    const [bytes, live] = await Promise.all([
      readFile(new URL(`target/contract-artifacts/bin/${binaryName}`, root)),
      rpc(rpcUrl, "get_live_cell", [{ tx_hash: options.transactionHash, index }, true]),
    ]);
    assert.equal(live.status, "live", `${binaryName} code cell is not live`);
    assert.deepEqual(live.cell.output.lock, ZERO_LOCK, `${binaryName} code cell is mutable`);
    assert.equal(
      live.cell.output.type,
      null,
      `${binaryName} code cell must not have a type script`,
    );
    const deployed = Buffer.from(live.cell.data.content.slice(2), "hex");
    assert.deepEqual(deployed, bytes, `${binaryName} deployed bytes differ from local artifacts`);
    assert.equal(
      transaction.transaction.outputs_data[position],
      `0x${bytes.toString("hex")}`,
      `${binaryName} transaction output data mismatch`,
    );
    contracts[key] = Object.freeze({
      codeHash: ckbHash(bytes),
      hashType: "data1",
      binarySha256: sha256(bytes),
      sizeBytes: bytes.length,
      cellDep: Object.freeze({
        outPoint: Object.freeze({ txHash: options.transactionHash, index }),
        depType: "code",
      }),
    });
  }
  return Object.freeze({
    schemaVersion: 3,
    releaseVersion: options.releaseVersion,
    network: "ckb_testnet",
    genesisHash: publicManifest.genesisHash,
    sourceRevision,
    predecessorManifests: Object.freeze([]),
    deployment: Object.freeze({
      transactionHash: options.transactionHash,
      blockHash: transaction.tx_status.block_hash,
      blockNumber: block.number,
      confirmations: confirmations.toString(),
    }),
    secp256k1Blake160: publicManifest.secp256k1Blake160,
    nervosDao: publicManifest.daoHarvest.nervosDao,
    contracts: Object.freeze(contracts),
  });
}

async function main() {
  const options = parseDaoHarvestV3ManifestArguments(process.argv.slice(2));
  const manifest = await createDaoHarvestV3Manifest(options);
  await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(`Wrote ${options.output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
