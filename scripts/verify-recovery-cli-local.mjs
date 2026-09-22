/* global fetch */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  assertCancellationCompletion,
  assertRecurringCompletion,
  buildRecurringCreation,
  deploymentRegistry,
  parseHash32,
  parseOutPoint,
} from "../packages/core/src/index.ts";
import {
  occupiedShannons,
  scriptHash,
  signSingleInput,
  toRpcTransaction,
} from "./lib/ckb-local.mjs";

const rpcUrl = process.env.CKB_RPC_URL ?? "http://127.0.0.1:58114";
const minerContainer = process.env.CKB_MINER_CONTAINER;
const initialFundingTxHash = process.env.RECOVERY_CLI_FUNDING_TX_HASH;
const initialFundingIndex = process.env.RECOVERY_CLI_FUNDING_INDEX ?? "0x1";
const transactionFee = 1_000_000n;
let rpcId = 0;

if (!minerContainer) {
  throw new Error("CKB_MINER_CONTAINER is required for the stateful recovery CLI proof");
}

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

function mineBlocks(count = 20) {
  execFileSync(
    "docker",
    ["exec", minerContainer, "ckb", "miner", "-C", "/var/lib/ckb", "--limit", String(count)],
    { stdio: "ignore" },
  );
}

async function commit(transaction) {
  const txHash = await rpc("send_transaction", [toRpcTransaction(transaction)]);
  mineBlocks();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await rpc("get_transaction", [txHash]);
    if (result?.tx_status?.status === "committed") return txHash;
    if (result?.tx_status?.status === "rejected") {
      throw new Error(`${txHash} was rejected: ${result.tx_status.reason}`);
    }
    await delay(250);
  }
  throw new Error(`${txHash} was not committed after mining`);
}

function fromRpcScript(value) {
  return { codeHash: value.code_hash, hashType: value.hash_type, args: value.args };
}

function runCli(args) {
  const output = execFileSync(process.execPath, ["scripts/recovery-cli.mjs", ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  });
  return JSON.parse(output);
}

const [genesisHash] = deploymentRegistry.genesisHashes;
assert.ok(genesisHash);
const loaded = await deploymentRegistry.load(genesisHash);
assert.equal(loaded.status, "ok");
if (loaded.status !== "ok") process.exit(1);
const deployment = loaded.deployment;
const fundingOutPoint = parseOutPoint({
  txHash: initialFundingTxHash ?? deployment.confirmation.verificationTransactionHash,
  index: initialFundingIndex,
});
const funding = await rpc("get_live_cell", [
  { tx_hash: fundingOutPoint.txHash, index: `0x${fundingOutPoint.index.toString(16)}` },
  false,
]);
assert.equal(funding.status, "live", "select a live disposable-chain funding outpoint");
const ownerLock = fromRpcScript(funding.cell.output.lock);
const ownerLockHash = parseHash32(scriptHash(ownerLock));
const tip = await rpc("get_tip_header");
const creation = buildRecurringCreation({
  deployment,
  ownerLockHash,
  recipientLockHash: parseHash32(`0x${"22".repeat(32)}`),
  amount: "10000000000",
  intervalBlocks: "10",
  firstNotBefore: BigInt(tip.number) + 20n,
  totalRuns: "2",
  reward: "10000000000",
  creatorNonce: "5301",
  creationFee: {
    transactionBytes: { minimum: "500", maximum: "900" },
    feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
  },
});
const fundingCapacity = BigInt(funding.cell.output.capacity);
const locked = BigInt(creation.transaction.outputs[0].capacity);
const ownerChange = fundingCapacity - locked - transactionFee;
assert.ok(ownerChange >= occupiedShannons({ capacity: "0x0", lock: ownerLock, type: null }, "0x"));
const completedCreation = {
  ...creation.transaction,
  inputs: [
    {
      since: "0x0",
      previousOutput: {
        txHash: fundingOutPoint.txHash,
        index: `0x${fundingOutPoint.index.toString(16)}`,
      },
    },
  ],
  outputs: [
    ...creation.transaction.outputs,
    { capacity: `0x${ownerChange.toString(16)}`, lock: ownerLock, type: null },
  ],
  outputsData: [...creation.transaction.outputsData, "0x"],
};
const signedCreation = signSingleInput(completedCreation, {
  lock: "",
  inputType: "",
  outputType: creation.completion.requiredOutputType,
});
assertRecurringCompletion(creation, signedCreation);
const creationHash = await commit(signedCreation);
const jobOutPoint = parseOutPoint({ txHash: creationHash, index: "0x0" });
const ownerChangeOutPoint = parseOutPoint({ txHash: creationHash, index: "0x1" });
const directory = await mkdtemp(join(tmpdir(), "ckb-automata-cli-proof-"));

try {
  const ownerPath = join(directory, "owner-lock.json");
  const exportPath = join(directory, "unsigned-cancel.json");
  await writeFile(ownerPath, JSON.stringify(ownerLock));
  const common = [
    "--manifest",
    "deploy/manifests/local.json",
    "--rpc-url",
    rpcUrl,
    "--out-point",
    `${jobOutPoint.txHash}:0x0`,
    "--owner-lock",
    ownerPath,
  ];
  const inspected = runCli(["inspect", ...common]);
  assert.equal(inspected.inspection.status, "ok");
  const cancellation = runCli(["cancel", ...common]);
  assert.equal(cancellation.operation, "cancel");
  const recovery = runCli(["recover", ...common, "--reason", "terminal_operational_failure"]);
  assert.equal(recovery.operation, "recover");
  const exported = runCli([
    "unsigned-export",
    ...common,
    "--mode",
    "cancel",
    "--output",
    exportPath,
  ]);
  assert.equal(exported.operation, "cancel");
  const artifact = JSON.parse(await readFile(exportPath, "utf8"));
  assert.deepEqual(artifact.transaction, cancellation.transaction);

  const cancellationChange = ownerChange - transactionFee;
  const completedCancellation = {
    ...artifact.transaction,
    inputs: [
      ...artifact.transaction.inputs,
      {
        since: "0x0",
        previousOutput: { txHash: ownerChangeOutPoint.txHash, index: "0x1" },
      },
    ],
    outputs: [
      ...artifact.transaction.outputs,
      { capacity: `0x${cancellationChange.toString(16)}`, lock: ownerLock, type: null },
    ],
    outputsData: [...artifact.transaction.outputsData, "0x"],
  };
  const signedCancellation = signSingleInput(
    completedCancellation,
    { lock: "", inputType: "", outputType: "" },
    undefined,
    1,
  );
  assertCancellationCompletion(
    {
      transaction: cancellation.transaction,
      jobOutPoint,
      jobId: cancellation.jobId,
      ownerLockHash: cancellation.ownerLockHash,
      refundCapacity: BigInt(cancellation.preview.refundCapacity),
      policy: inspected.inspection.policy,
      completion: cancellation.completion,
    },
    signedCancellation,
  );
  const dryRun = await rpc("dry_run_transaction", [toRpcTransaction(signedCancellation)]);
  assert.ok(BigInt(dryRun.cycles) > 0n);
  const cancellationHash = await commit(signedCancellation);
  console.log(
    `Recovery CLI exported and committed ${cancellationHash} after ${dryRun.cycles} dry-run cycles`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
