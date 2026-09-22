import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildRecurringCreation,
  deploymentRegistry,
  parseHash32,
  parseOutPoint,
} from "../packages/core/src/index.ts";
import { executeRecoveryCli } from "./recovery-cli-lib.mjs";
import { scriptHash } from "./lib/ckb-local.mjs";

const manifestPath = fileURLToPath(new URL("../deploy/manifests/local.json", import.meta.url));
const jobOutPoint = parseOutPoint({ txHash: `0x${"53".repeat(32)}`, index: "0" });

async function fixture() {
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("local deployment unavailable");
  const deployment = loaded.deployment;
  const ownerLock = {
    codeHash: deployment.manifest.secp256k1Blake160.codeHash,
    hashType: deployment.manifest.secp256k1Blake160.hashType,
    args: deployment.manifest.fixtureWallet.lockArg,
  };
  const creation = buildRecurringCreation({
    deployment,
    ownerLockHash: parseHash32(scriptHash(ownerLock)),
    recipientLockHash: parseHash32(`0x${"22".repeat(32)}`),
    amount: "10000000000",
    intervalBlocks: "10",
    firstNotBefore: "100",
    totalRuns: "2",
    reward: "10000000000",
    creatorNonce: "53",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "900" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  });
  const methods = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    methods.push(body.method);
    const result =
      body.method === "get_block_hash"
        ? deployment.genesisHash
        : body.method === "get_live_cell"
          ? {
              status: "live",
              cell: {
                output: {
                  capacity: creation.transaction.outputs[0].capacity,
                  lock: {
                    code_hash: creation.transaction.outputs[0].lock.codeHash,
                    hash_type: creation.transaction.outputs[0].lock.hashType,
                    args: creation.transaction.outputs[0].lock.args,
                  },
                  type: {
                    code_hash: creation.transaction.outputs[0].type.codeHash,
                    hash_type: creation.transaction.outputs[0].type.hashType,
                    args: creation.transaction.outputs[0].type.args,
                  },
                },
                data: { content: creation.jobData },
              },
            }
          : undefined;
    return {
      ok: result !== undefined,
      status: result === undefined ? 500 : 200,
      async json() {
        return result === undefined
          ? { error: { message: "unexpected method" } }
          : { id: body.id, jsonrpc: "2.0", result };
      },
    };
  };
  return { deployment, ownerLock, methods, fetchImpl };
}

async function withFiles(callback) {
  const directory = await mkdtemp(join(tmpdir(), "ckb-automata-recovery-"));
  const ownerPath = join(directory, "owner-lock.json");
  const outputPath = join(directory, "unsigned.json");
  try {
    const data = await fixture();
    await writeFile(ownerPath, JSON.stringify(data.ownerLock));
    await callback({ ...data, ownerPath, outputPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function common(ownerPath) {
  return [
    "--manifest",
    manifestPath,
    "--rpc-url",
    "http://127.0.0.1:18114",
    "--out-point",
    `${jobOutPoint.txHash}:0x0`,
    "--owner-lock",
    ownerPath,
  ];
}

test("inspect, cancel, and recover use only manifest and public RPC inputs", async () => {
  await withFiles(async ({ deployment, methods, fetchImpl, ownerPath }) => {
    const inspect = await executeRecoveryCli(["inspect", ...common(ownerPath)], { fetchImpl });
    assert.equal(inspect.command, "inspect");
    assert.equal(inspect.genesisHash, deployment.genesisHash);
    assert.equal(inspect.inspection.status, "ok");

    const cancel = await executeRecoveryCli(["cancel", ...common(ownerPath)], { fetchImpl });
    assert.equal(cancel.operation, "cancel");
    assert.equal(cancel.preview.paysExecutorReward, false);
    assert.equal(cancel.transaction.inputs.length, 1);

    const recover = await executeRecoveryCli(
      ["recover", ...common(ownerPath), "--reason", "terminal_operational_failure"],
      { fetchImpl },
    );
    assert.equal(recover.operation, "recover");
    assert.equal(recover.preview.createsSuccessor, false);
    assert.deepEqual(new Set(methods), new Set(["get_block_hash", "get_live_cell"]));
  });
});

test("unsigned-export writes a create-only wallet artifact", async () => {
  await withFiles(async ({ fetchImpl, ownerPath, outputPath }) => {
    const result = await executeRecoveryCli(
      ["unsigned-export", ...common(ownerPath), "--mode", "cancel", "--output", outputPath],
      { fetchImpl },
    );
    assert.equal(result.operation, "cancel");
    const artifact = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.operation, "cancel");
    assert.equal(artifact.transaction.inputs.length, 1);
    await assert.rejects(
      executeRecoveryCli(
        ["unsigned-export", ...common(ownerPath), "--mode", "cancel", "--output", outputPath],
        { fetchImpl },
      ),
      /EEXIST/,
    );
  });
});

test("CLI rejects wrong networks, unsupported reasons, and signing material", async () => {
  await withFiles(async ({ fetchImpl, ownerPath }) => {
    const wrongNetworkFetch = async (url, request) => {
      const response = await fetchImpl(url, request);
      const payload = await response.json();
      if (JSON.parse(request.body).method === "get_block_hash") {
        payload.result = `0x${"ff".repeat(32)}`;
      }
      return {
        ...response,
        async json() {
          return payload;
        },
      };
    };
    await assert.rejects(
      executeRecoveryCli(["inspect", ...common(ownerPath)], { fetchImpl: wrongNetworkFetch }),
      /does not match manifest genesis/,
    );
    await assert.rejects(
      executeRecoveryCli(
        [
          "inspect",
          ...common(ownerPath).map((value) =>
            value === "http://127.0.0.1:18114" ? "http://user:secret@127.0.0.1:18114" : value,
          ),
        ],
        { fetchImpl },
      ),
      /must not contain credentials/,
    );
    await assert.rejects(
      executeRecoveryCli(["recover", ...common(ownerPath), "--reason", "guess"], { fetchImpl }),
      /--reason must be/,
    );
    await assert.rejects(
      executeRecoveryCli(
        ["cancel", ...common(ownerPath), "--private-key", `0x${"01".repeat(32)}`],
        {
          fetchImpl,
        },
      ),
      /Unknown option/,
    );
  });
});

test("CLI entrypoint reports machine-readable failures", () => {
  const result = spawnSync(process.execPath, ["scripts/recovery-cli.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.name, "TypeError");
  assert.match(failure.error.message, /select exactly one command/);
});
