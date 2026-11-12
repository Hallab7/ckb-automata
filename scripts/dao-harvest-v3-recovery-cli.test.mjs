import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DaoHarvestPayloadV3,
  DaoHarvestPrepareCreditV3,
  DaoHarvestProgressV3,
} from "../packages/molecule/src/index.ts";
import {
  createEpoch,
  deriveDaoHarvestV3PrepareCreditHash,
  encodeAbsoluteEpochSince,
  parseHash32,
  scriptIdentityHash,
} from "../packages/core/src/index.ts";
import { executeDaoHarvestV3RecoveryCli } from "./dao-harvest-v3-recovery-cli-lib.mjs";

const hash = (character) => parseHash32(`0x${character.repeat(64)}`);
const hashBytes = (character) => [...Buffer.from(hash(character).slice(2), "hex")];
const point = (character, index = 0) => `${hash(character)}:0x${index.toString(16)}`;
const dep = (character) => ({
  outPoint: { txHash: hash(character), index: "0x0" },
  depType: "code",
});
const ownerLock = { codeHash: hash("1"), hashType: "type", args: "0x1234" };
const ownerHash = scriptIdentityHash(ownerLock);
const daoTypeHash = scriptIdentityHash({ codeHash: hash("6"), hashType: "type", args: "0x" });
const manifest = {
  schema: "ckb-automata/dao-harvest-deployment/v3",
  network: "ckb_testnet",
  genesisHash: hash("a"),
  manifestSha256: "b".repeat(64),
  secp256k1Blake160: { cellDep: dep("1") },
  nervosDao: { codeHash: hash("6"), cellDep: dep("6") },
  contracts: {
    jobLock: { codeHash: hash("2"), cellDep: dep("2") },
    policy: { codeHash: hash("3"), cellDep: dep("3") },
    vaultLock: { codeHash: hash("4"), cellDep: dep("4") },
    compensationLock: { codeHash: hash("5"), cellDep: dep("5") },
  },
};
const payload = DaoHarvestPayloadV3.pack({
  version: 3,
  owner_lock_hash: [...Buffer.from(ownerHash.slice(2), "hex")],
  payout_lock_hash: hashBytes("3"),
  vault_lock_code_hash: hashBytes("4"),
  compensation_lock_code_hash: hashBytes("5"),
  dao_type_hash: [...Buffer.from(daoTypeHash.slice(2), "hex")],
  principal_capacity: "1000",
  preferred_prepare_operator_lock_hash: Array(32).fill(7),
  fallback_prepare_executor_set_hash: Array(32).fill(8),
  prepare_service_fee: "10",
  claim_service_fee: "10",
  compensation_seed_capacity: "50",
  prepare_buffer_epochs: "1152921504606846977",
  takeover_delay_epochs: "1152921504606846977",
  confirmation_margin_epochs: "1152921504606846977",
  total_cycles: 1,
  end_epoch_since: "0",
});
const credit = DaoHarvestPrepareCreditV3.pack({
  version: 3,
  job_id: Array(32).fill(9),
  cycle_index: 0,
  preparer_lock_hash: Array(32).fill(10),
  prepared_vault_output_index: 1,
  job_output_index: 0,
});
const deposited = DaoHarvestProgressV3.pack({
  version: 3,
  state: 0,
  cycle_index: 0,
  prepare_credit_hash: Array(32).fill(0),
});
const withdrawing = DaoHarvestProgressV3.pack({
  version: 3,
  state: 1,
  cycle_index: 0,
  prepare_credit_hash: [...deriveDaoHarvestV3PrepareCreditHash(credit)],
});
const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;
const toRpcScript = (value) =>
  value === null
    ? null
    : { code_hash: value.codeHash, hash_type: value.hashType, args: value.args };

function rpcFixture({ stale = false, tipEpoch = 400n } = {}) {
  const cells = new Map([
    [
      hash("c"),
      {
        capacity: 100n,
        lock: { ...ownerLock, args: "0x01" },
        type: { codeHash: hash("3"), hashType: "type", args: "0x" },
        data: "0x",
      },
    ],
    [
      hash("d"),
      {
        capacity: 1000n,
        lock: { codeHash: hash("4"), hashType: "type", args: "0x" },
        type: { codeHash: hash("6"), hashType: "type", args: "0x" },
        data: "0x2a00000000000000",
      },
    ],
    [
      hash("e"),
      {
        capacity: 50n,
        lock: { codeHash: hash("5"), hashType: "type", args: "0x" },
        type: null,
        data: "0x",
      },
    ],
    [hash("f"), { capacity: 200n, lock: ownerLock, type: null, data: "0x" }],
    [
      hash("9"),
      {
        capacity: 100n,
        lock: { codeHash: hash("9"), hashType: "type", args: "0x" },
        type: null,
        data: "0x",
      },
    ],
  ]);
  return async (_url, request) => {
    const body = JSON.parse(request.body);
    let result;
    if (body.method === "get_block_hash") result = manifest.genesisHash;
    if (body.method === "get_live_cell") {
      const cell = cells.get(body.params[0].tx_hash);
      result =
        stale && body.params[0].tx_hash === hash("c")
          ? { status: "dead" }
          : {
              status: "live",
              cell: {
                output: {
                  capacity: `0x${cell.capacity.toString(16)}`,
                  lock: toRpcScript(cell.lock),
                  type: toRpcScript(cell.type),
                },
                data: { content: cell.data },
              },
            };
    }
    if (body.method === "get_header")
      result = {
        dao: `0x${"00".repeat(8)}${body.params[0] === hash("7") ? "e803000000000000" : "4c04000000000000"}${"00".repeat(16)}`,
      };
    if (body.method === "get_tip_header") result = { epoch: `0x${tipEpoch.toString(16)}` };
    return {
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: body.id, result };
      },
    };
  };
}

async function files() {
  const directory = await mkdtemp(join(tmpdir(), "ckb-automata-v3-recovery-"));
  const manifestPath = join(directory, "manifest.json");
  const ownerPath = join(directory, "owner.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(ownerPath, JSON.stringify(ownerLock));
  return { directory, manifestPath, ownerPath };
}
const common = (paths, output, progress) => [
  "--manifest",
  paths.manifestPath,
  "--rpc-url",
  "https://rpc.example",
  "--owner-lock",
  paths.ownerPath,
  "--job",
  point("c"),
  "--vault",
  point("d"),
  "--compensation",
  point("e"),
  "--identity",
  point("f"),
  "--payload",
  hex(payload),
  "--progress",
  hex(progress),
  "--deposit-header",
  hash("7"),
  "--fee",
  "1",
  "--output",
  output,
];

test("fresh-checkout owner exit export is service-independent and preserves DAO index one", async () => {
  const paths = await files();
  try {
    const output = join(paths.directory, "exit.json");
    await executeDaoHarvestV3RecoveryCli(["owner-exit", ...common(paths, output, deposited)], {
      fetchImpl: rpcFixture(),
    });
    const artifact = JSON.parse(await readFile(output, "utf8"));
    assert.equal(artifact.schema, "ckb-automata/dao-harvest-recovery/v3");
    assert.equal(artifact.transaction.inputs[1].previousOutput.txHash, hash("d"));
    assert.equal(artifact.transaction.outputs[1].lock.args, ownerLock.args);
    assert.equal(artifact.transaction.outputsData[1], "0x2a00000000000000");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("mature owner recovery exports without CKAutomata services and rejects immature tips", async () => {
  const paths = await files();
  const claimSince = encodeAbsoluteEpochSince(createEpoch({ number: 380n, index: 0n, length: 0n }));
  const args = (output) => [
    "owner-recovery",
    ...common(paths, output, withdrawing),
    "--prepare-accumulator",
    point("9"),
    "--credit",
    hex(credit),
    "--prepare-header",
    hash("8"),
    "--claim-since",
    claimSince.toString(),
    "--vault-occupied-capacity",
    "100",
  ];
  try {
    const output = join(paths.directory, "recovery.json");
    await executeDaoHarvestV3RecoveryCli(args(output), { fetchImpl: rpcFixture() });
    const artifact = JSON.parse(await readFile(output, "utf8"));
    assert.equal(artifact.operation, "owner-recovery");
    assert.equal(artifact.signingEntries[0].type, "owner");
    await assert.rejects(
      executeDaoHarvestV3RecoveryCli(args(join(paths.directory, "immature.json")), {
        fetchImpl: rpcFixture({ tipEpoch: 379n }),
      }),
      /not mature/,
    );
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("recovery export fails closed on stale outpoints and mismatched manifests", async () => {
  const paths = await files();
  try {
    await assert.rejects(
      executeDaoHarvestV3RecoveryCli(
        ["owner-exit", ...common(paths, join(paths.directory, "stale.json"), deposited)],
        { fetchImpl: rpcFixture({ stale: true }) },
      ),
      /stale/,
    );
    await writeFile(
      paths.manifestPath,
      JSON.stringify({ ...manifest, schema: "ckb-automata/dao-harvest-deployment/v2" }),
    );
    await assert.rejects(
      executeDaoHarvestV3RecoveryCli(
        ["owner-exit", ...common(paths, join(paths.directory, "bad.json"), deposited)],
        { fetchImpl: rpcFixture() },
      ),
      /manifest/,
    );
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});
