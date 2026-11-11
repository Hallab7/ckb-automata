import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  DaoHarvestPayloadV3,
  DaoHarvestPrepareCreditV3,
  DaoHarvestProgressV3,
} from "../packages/molecule/src/index.ts";
import {
  buildDaoHarvestV3OwnerExit,
  buildDaoHarvestV3OwnerRecovery,
  calculateDaoMaximumWithdraw,
  compareEpochFractions,
  decodeAbsoluteEpochSince,
  parseEpoch,
  parseHash32,
  parseOutPoint,
  scriptIdentityHash,
} from "../packages/core/src/index.ts";

const required = (values, name) => {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`--${name} is required`);
  return value;
};
const whole = (value, name) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new TypeError(`${name} must be a canonical whole number`);
  return BigInt(value);
};
const hexBytes = (value, name) => {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value))
    throw new TypeError(`${name} must be canonical lowercase hex`);
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
};
const asHex = (value) => `0x${Buffer.from(value).toString("hex")}`;

function point(value, name) {
  const separator = value.lastIndexOf(":");
  if (separator < 1) throw new TypeError(`${name} must use TX_HASH:INDEX`);
  return parseOutPoint({ txHash: value.slice(0, separator), index: value.slice(separator + 1) });
}
const rpcPoint = (value) => ({ tx_hash: value.txHash, index: `0x${value.index.toString(16)}` });
const txPoint = (value) => ({ txHash: value.txHash, index: `0x${value.index.toString(16)}` });

function script(value, name) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.codeHash !== "string" ||
    !["data", "data1", "type"].includes(value.hashType) ||
    !/^0x(?:[0-9a-f]{2})*$/.test(value.args)
  )
    throw new TypeError(`${name} is not a canonical CKB script`);
  return Object.freeze({
    codeHash: parseHash32(value.codeHash),
    hashType: value.hashType,
    args: value.args,
  });
}
function dep(value, name) {
  if (!value || typeof value !== "object" || !["code", "depGroup"].includes(value.depType))
    throw new TypeError(`${name} is not a canonical cell dep`);
  const outPoint = parseOutPoint(value.outPoint);
  return Object.freeze({ outPoint: txPoint(outPoint), depType: value.depType });
}
function contract(value, name) {
  if (!value || typeof value !== "object") throw new TypeError(`${name} is missing`);
  return Object.freeze({
    codeHash: parseHash32(value.codeHash),
    cellDep: dep(value.cellDep, `${name}.cellDep`),
  });
}

async function loadManifest(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    value?.schema !== "ckb-automata/dao-harvest-deployment/v3" ||
    value?.network !== "ckb_testnet" ||
    !/^[0-9a-f]{64}$/.test(value.manifestSha256 ?? "")
  )
    throw new TypeError("V3 deployment manifest is invalid or not versioned");
  return Object.freeze({
    network: "ckb_testnet",
    genesisHash: parseHash32(value.genesisHash),
    manifestSha256: value.manifestSha256,
    secp256k1Blake160: {
      cellDep: dep(value.secp256k1Blake160?.cellDep, "secp256k1Blake160.cellDep"),
    },
    nervosDao: contract(value.nervosDao, "nervosDao"),
    contracts: Object.freeze({
      jobLock: contract(value.contracts?.jobLock, "contracts.jobLock"),
      policy: contract(value.contracts?.policy, "contracts.policy"),
      vaultLock: contract(value.contracts?.vaultLock, "contracts.vaultLock"),
      compensationLock: contract(value.contracts?.compensationLock, "contracts.compensationLock"),
    }),
  });
}

function createRpc(urlValue, fetchImpl) {
  const url = new URL(urlValue);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new TypeError("RPC URL must use HTTP(S) without credentials");
  let id = 0;
  return async (method, params = []) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = await response.json();
    if (!response.ok || body.error)
      throw new Error(`${method}: ${body.error?.message ?? `HTTP ${response.status}`}`);
    return body.result;
  };
}
const fromRpcScript = (value) =>
  value === null
    ? null
    : script(
        { codeHash: value.code_hash, hashType: value.hash_type, args: value.args },
        "RPC script",
      );
async function liveCell(rpc, outPoint, name) {
  const result = await rpc("get_live_cell", [rpcPoint(outPoint), true]);
  if (result?.status !== "live") throw new Error(`${name} is stale or already spent`);
  return Object.freeze({
    outPoint,
    capacity: BigInt(result.cell.output.capacity),
    lock: fromRpcScript(result.cell.output.lock),
    type: fromRpcScript(result.cell.output.type),
    data: result.cell.data.content,
  });
}
function accumulatedRate(header, name) {
  if (!header || !/^0x[0-9a-f]{64}$/.test(header.dao ?? ""))
    throw new Error(`${name} is not canonical`);
  return BigInt(`0x${header.dao.slice(18, 34).match(/../g).toReversed().join("")}`);
}
const reviewedInput = (cell, since = 0n, capacity = cell.capacity) => ({
  input: { since: `0x${since.toString(16)}`, previousOutput: txPoint(cell.outPoint) },
  capacity,
  lockHash: scriptIdentityHash(cell.lock),
});
const reviewedOutput = (capacity, lock, type, data = "0x") => ({
  output: { capacity: `0x${capacity.toString(16)}`, lock, type },
  data,
});

function options(argv) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      manifest: { type: "string" },
      "rpc-url": { type: "string" },
      "owner-lock": { type: "string" },
      job: { type: "string" },
      vault: { type: "string" },
      compensation: { type: "string" },
      identity: { type: "string" },
      "prepare-accumulator": { type: "string" },
      payload: { type: "string" },
      progress: { type: "string" },
      credit: { type: "string" },
      "deposit-header": { type: "string" },
      "prepare-header": { type: "string" },
      "claim-since": { type: "string" },
      "vault-occupied-capacity": { type: "string" },
      fee: { type: "string", default: "100000" },
      output: { type: "string" },
    },
  });
  if (
    parsed.positionals.length !== 1 ||
    !["owner-exit", "owner-recovery"].includes(parsed.positionals[0])
  )
    throw new TypeError("select owner-exit or owner-recovery");
  return { operation: parsed.positionals[0], values: parsed.values };
}

export async function executeDaoHarvestV3RecoveryCli(
  argv,
  { fetchImpl = globalThis.fetch, writeFileImpl = writeFile } = {},
) {
  const { operation, values } = options(argv);
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const [deployment, ownerLock] = await Promise.all([
    loadManifest(required(values, "manifest")),
    readFile(required(values, "owner-lock"), "utf8").then((body) =>
      script(JSON.parse(body), "owner lock"),
    ),
  ]);
  const rpc = createRpc(required(values, "rpc-url"), fetchImpl);
  const genesis = parseHash32(await rpc("get_block_hash", ["0x0"]));
  if (genesis !== deployment.genesisHash)
    throw new Error("RPC genesis does not match the V3 manifest");
  const refs = {
    job: point(required(values, "job"), "job"),
    vault: point(required(values, "vault"), "vault"),
    compensation: point(required(values, "compensation"), "compensation"),
    identity: point(required(values, "identity"), "identity"),
  };
  const [job, vault, compensation, identity] = await Promise.all(
    Object.entries(refs).map(([name, ref]) => liveCell(rpc, ref, name)),
  );
  const payloadBytes = hexBytes(required(values, "payload"), "payload");
  const progressBytes = hexBytes(required(values, "progress"), "progress");
  const payload = DaoHarvestPayloadV3.unpack(payloadBytes);
  const progress = DaoHarvestProgressV3.unpack(progressBytes);
  if (Number(payload.version) !== 3 || Number(progress.version) !== 3)
    throw new Error("recovery inputs are not V3");
  const ownerHash = scriptIdentityHash(ownerLock);
  if (asHex(Uint8Array.from(payload.owner_lock_hash)) !== ownerHash)
    throw new Error("owner lock does not match the V3 payload");
  const fee = whole(required(values, "fee"), "fee");
  if (identity.capacity <= fee) throw new Error("owner identity cell cannot cover the network fee");
  const depositHash = parseHash32(required(values, "deposit-header"));
  const depositHeader = await rpc("get_header", [depositHash]);
  if (!depositHeader) throw new Error("deposit header is not canonical");
  const context = {
    rpcGenesisHash: genesis,
    deployment,
    canonicalHeaderHashes: [depositHash],
    liveOutPoints: Object.values(refs).map(txPoint),
    signerLockHash: ownerHash,
  };
  const common = {
    context,
    policyScriptHash: deployment.contracts.policy.codeHash,
    ownerLockHash: ownerHash,
    payload: payloadBytes,
    progress: progressBytes,
    maximumNetworkFee: fee,
    allowedFundingLockHashes: [ownerHash],
  };
  let build;
  if (operation === "owner-exit") {
    if (Number(progress.state) !== 0)
      throw new Error("owner exit requires a deposited V3 position");
    const principal = BigInt(payload.principal_capacity.toString());
    const refund = job.capacity + compensation.capacity;
    build = buildDaoHarvestV3OwnerExit({
      ...common,
      inputs: {
        job: reviewedInput(job),
        vault: reviewedInput(vault),
        compensation: reviewedInput(compensation),
        identity: reviewedInput(identity),
      },
      outputs: {
        vault: reviewedOutput(principal, ownerLock, vault.type, vault.data),
        additional: [
          reviewedOutput(refund, ownerLock, null),
          reviewedOutput(identity.capacity - fee, ownerLock, null),
        ],
      },
      headerDeps: [depositHash],
    });
  } else {
    if (Number(progress.state) !== 1)
      throw new Error("owner recovery requires a withdrawing V3 position");
    const prepareRef = point(required(values, "prepare-accumulator"), "prepare-accumulator");
    const prepareAccumulator = await liveCell(rpc, prepareRef, "prepare accumulator");
    context.liveOutPoints = [...context.liveOutPoints, txPoint(prepareRef)];
    const prepareHash = parseHash32(required(values, "prepare-header"));
    const [prepareHeader, tip] = await Promise.all([
      rpc("get_header", [prepareHash]),
      rpc("get_tip_header"),
    ]);
    if (!prepareHeader) throw new Error("prepare header is not canonical");
    context.canonicalHeaderHashes = [depositHash, prepareHash];
    const claimSince = whole(required(values, "claim-since"), "claim-since");
    if (compareEpochFractions(parseEpoch(tip.epoch), decodeAbsoluteEpochSince(claimSince)) < 0)
      throw new Error("DAO withdrawal is not mature for owner recovery");
    const creditBytes = hexBytes(required(values, "credit"), "credit");
    const credit = DaoHarvestPrepareCreditV3.unpack(creditBytes);
    const maximum = calculateDaoMaximumWithdraw({
      principal: BigInt(payload.principal_capacity.toString()),
      occupiedCapacity: whole(
        required(values, "vault-occupied-capacity"),
        "vault-occupied-capacity",
      ),
      depositAccumulatedRate: accumulatedRate(depositHeader, "deposit header"),
      withdrawingAccumulatedRate: accumulatedRate(prepareHeader, "prepare header"),
    });
    const gross = maximum - BigInt(payload.principal_capacity.toString());
    const preparePayment =
      gross < BigInt(payload.prepare_service_fee.toString())
        ? gross
        : BigInt(payload.prepare_service_fee.toString());
    const ownerPayout = maximum - preparePayment + compensation.capacity + job.capacity;
    build = buildDaoHarvestV3OwnerRecovery({
      ...common,
      context,
      prepareCredit: creditBytes,
      inputs: {
        job: reviewedInput(job),
        vault: reviewedInput(vault, claimSince, maximum),
        compensation: reviewedInput(compensation),
        identity: reviewedInput(identity),
        prepareAccumulator: reviewedInput(prepareAccumulator),
      },
      outputs: {
        prepareAccumulator: reviewedOutput(
          prepareAccumulator.capacity + preparePayment,
          prepareAccumulator.lock,
          null,
        ),
        additional: [
          reviewedOutput(ownerPayout, ownerLock, null),
          reviewedOutput(identity.capacity - fee, ownerLock, null),
        ],
      },
      headerDeps: [depositHash, prepareHash],
    });
    void credit;
  }
  const artifact = Object.freeze({
    schema: "ckb-automata/dao-harvest-recovery/v3",
    network: "ckb_testnet",
    genesisHash: genesis,
    manifestSha256: deployment.manifestSha256,
    operation,
    intentHash: build.intentHash,
    value: build.value,
    signingEntries: [{ type: "owner", lockHash: ownerHash, inputIndex: 3 }],
    transaction: build.transaction,
  });
  const output = required(values, "output");
  await writeFileImpl(
    output,
    `${JSON.stringify(artifact, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
    { flag: "wx" },
  );
  return Object.freeze({ operation, output, intentHash: build.intentHash });
}
