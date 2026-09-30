import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  buildDaoHarvestMatureRecovery,
  buildDaoHarvestOwnerExit,
  buildDaoHarvestRecovery,
  buildDaoHarvestStopRecurrence,
  encodeAbsoluteEpochSince,
  parseHash32,
  parseEpoch,
  parseOutPoint,
  planDaoHarvestRecovery,
  scriptIdentityHash,
} from "../packages/core/src/index.ts";

function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`--${name.replaceAll("_", "-")} is required`);
  }
  return value;
}

function canonicalInteger(value, name) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`--${name} must be a whole number`);
  return value;
}

function daoAccumulatedRate(header, name) {
  if (
    typeof header !== "object" ||
    header === null ||
    typeof header.dao !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(header.dao)
  ) {
    throw new TypeError(`${name} is missing canonical DAO header data`);
  }
  const littleEndian = header.dao.slice(18, 34).match(/../g);
  if (littleEndian === null) throw new TypeError(`${name} accumulated rate is invalid`);
  return BigInt(`0x${littleEndian.toReversed().join("")}`).toString();
}

function outPoint(value, name) {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new TypeError(`--${name} must use TX_HASH:INDEX`);
  }
  return parseOutPoint({ txHash: value.slice(0, separator), index: value.slice(separator + 1) });
}

function rpcScript(value, name) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.codeHash !== "string" ||
    !["data", "data1", "type"].includes(value.hashType) ||
    typeof value.args !== "string" ||
    !/^0x(?:[0-9a-f]{2})*$/.test(value.args)
  ) {
    throw new TypeError(`${name} is not a canonical CKB script`);
  }
  return Object.freeze({
    codeHash: parseHash32(value.codeHash),
    hashType: value.hashType,
    args: value.args,
  });
}

function cellDep(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} is not a cell dependency`);
  }
  const point = parseOutPoint(value.outPoint);
  return Object.freeze({
    outPoint: Object.freeze({ txHash: point.txHash, index: `0x${point.index.toString(16)}` }),
    depType:
      value.depType === "depGroup"
        ? "depGroup"
        : value.depType === "code"
          ? "code"
          : (() => {
              throw new TypeError(`${name}.depType is invalid`);
            })(),
  });
}

function contract(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} is not a contract deployment`);
  }
  const script = rpcScript({ ...value.script, args: "0x" }, `${name}.script`);
  return Object.freeze({
    script: Object.freeze({ codeHash: script.codeHash, hashType: script.hashType }),
    cellDep: cellDep(value.cellDep, `${name}.cellDep`),
  });
}

async function loadDeployment(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.network !== "ckb_testnet" ||
    typeof value.manifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.manifestSha256)
  ) {
    throw new TypeError("harvest deployment artifact is invalid");
  }
  return Object.freeze({
    network: "ckb_testnet",
    genesisHash: parseHash32(value.genesisHash),
    manifestSha256: value.manifestSha256,
    secp256k1Blake160: Object.freeze({
      cellDep: cellDep(value.secp256k1Blake160?.cellDep, "secp256k1Blake160.cellDep"),
    }),
    jobLock: contract(value.jobLock, "jobLock"),
    policy: contract(value.policy, "policy"),
    vaultLock: contract(value.vaultLock, "vaultLock"),
    daoType: contract(value.daoType, "daoType"),
  });
}

async function loadOwnerLock(path) {
  return rpcScript(JSON.parse(await readFile(path, "utf8")), "owner lock file");
}

function createRpc(urlValue, fetchImpl) {
  const url = new URL(urlValue);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError("RPC URL must use HTTP(S) and contain no credentials");
  }
  let id = 0;
  return async (method, params = []) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ++id, jsonrpc: "2.0", method, params }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error)
      throw new Error(`${method}: ${payload.error?.message ?? `HTTP ${response.status}`}`);
    return payload.result;
  };
}

function fromRpcScript(value) {
  return value === null
    ? null
    : {
        codeHash: value.code_hash,
        hashType: value.hash_type,
        args: value.args,
      };
}

async function liveCell(rpc, point) {
  const result = await rpc("get_live_cell", [
    { tx_hash: point.txHash, index: `0x${point.index.toString(16)}` },
    true,
  ]);
  if (result?.status !== "live") return null;
  return Object.freeze({
    outPoint: point,
    output: Object.freeze({
      capacity: result.cell.output.capacity,
      lock: fromRpcScript(result.cell.output.lock),
      type: fromRpcScript(result.cell.output.type),
    }),
    data: result.cell.data.content,
  });
}

function parseCommand(argv) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      "harvest-deployment": { type: "string" },
      "rpc-url": { type: "string" },
      "owner-lock": { type: "string" },
      "owner-out-point": { type: "string" },
      "vault-out-point": { type: "string" },
      "out-point": { type: "string" },
      "deposit-header": { type: "string" },
      "deposit-block": { type: "string" },
      "prepare-header": { type: "string" },
      "vault-occupied-capacity": { type: "string" },
      "claim-since": { type: "string" },
      payload: { type: "string" },
      condition: { type: "string", default: "normal" },
      "vault-state": { type: "string" },
      "claim-mature": { type: "boolean", default: false },
      operation: { type: "string" },
      output: { type: "string" },
    },
  });
  if (
    parsed.positionals.length !== 1 ||
    !["harvest-plan", "harvest-export"].includes(parsed.positionals[0])
  ) {
    throw new TypeError("select harvest-plan or harvest-export");
  }
  return { command: parsed.positionals[0], values: parsed.values };
}

function plan(values) {
  const rawCondition = required(values, "condition");
  const condition =
    rawCondition === "normal" ||
    rawCondition === "budget_exhausted" ||
    rawCondition === "deprecated" ||
    rawCondition === "service_unavailable"
      ? rawCondition
      : (() => {
          throw new TypeError("--condition is unsupported");
        })();
  const rawState = required(values, "vault-state");
  const vaultState =
    rawState === "deposited" || rawState === "withdrawing"
      ? rawState
      : (() => {
          throw new TypeError("--vault-state must be deposited or withdrawing");
        })();
  return planDaoHarvestRecovery({
    condition,
    vaultState,
    claimMature: values["claim-mature"] === true,
  });
}

export async function executeDaoHarvestRecoveryCli(
  argv,
  { fetchImpl = globalThis.fetch, writeFileImpl = writeFile } = {},
) {
  const { command, values } = parseCommand(argv);
  if (command === "harvest-plan") return Object.freeze({ command, plan: plan(values) });
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const deployment = await loadDeployment(required(values, "harvest-deployment"));
  const rpc = createRpc(required(values, "rpc-url"), fetchImpl);
  const remoteGenesis = parseHash32(await rpc("get_block_hash", ["0x0"]));
  if (remoteGenesis !== deployment.genesisHash)
    throw new Error("RPC genesis does not match harvest deployment");
  const ownerLock = await loadOwnerLock(required(values, "owner-lock"));
  const ownerOutPoint = outPoint(required(values, "owner-out-point"), "owner-out-point");
  const resolver = Object.freeze({ resolve: (point) => liveCell(rpc, point) });
  const operation = required(values, "operation");
  let build;
  if (operation === "mature-recovery") {
    const vaultOutPoint = outPoint(required(values, "vault-out-point"), "vault-out-point");
    const depositHeaderHash = parseHash32(required(values, "deposit-header"));
    const prepareHeaderHash = parseHash32(required(values, "prepare-header"));
    const [tip, depositHeader, prepareHeader] = await Promise.all([
      rpc("get_tip_header"),
      rpc("get_header", [depositHeaderHash]),
      rpc("get_header", [prepareHeaderHash]),
    ]);
    if (typeof tip?.epoch !== "string") throw new Error("get_tip_header: epoch is missing");
    build = await buildDaoHarvestMatureRecovery({
      deployment,
      expectedGenesisHash: deployment.genesisHash,
      resolver,
      vaultOutPoint,
      ownerOutPoint,
      ownerLock,
      ownerLockHash: scriptIdentityHash(ownerLock),
      depositHeaderHash,
      prepareHeaderHash,
      depositAccumulatedRate: daoAccumulatedRate(depositHeader, "deposit header"),
      withdrawingAccumulatedRate: daoAccumulatedRate(prepareHeader, "prepare header"),
      vaultOccupiedCapacity: canonicalInteger(
        required(values, "vault-occupied-capacity"),
        "vault-occupied-capacity",
      ),
      claimSince: canonicalInteger(required(values, "claim-since"), "claim-since"),
      currentEpochSince: encodeAbsoluteEpochSince(parseEpoch(tip.epoch)),
    });
  } else {
    const jobOutPoint = outPoint(required(values, "out-point"), "out-point");
    const common = {
      deployment,
      expectedGenesisHash: deployment.genesisHash,
      resolver,
      jobOutPoint,
      ownerOutPoint,
      ownerLock,
      ownerLockHash: scriptIdentityHash(ownerLock),
      payload: required(values, "payload"),
    };
    build =
      operation === "stop"
        ? await buildDaoHarvestStopRecurrence(common)
        : operation === "recover"
          ? await buildDaoHarvestRecovery(common)
          : operation === "owner-exit"
            ? await buildDaoHarvestOwnerExit({
                ...common,
                vaultOutPoint: outPoint(required(values, "vault-out-point"), "vault-out-point"),
                depositHeaderHash: parseHash32(required(values, "deposit-header")),
                depositBlockNumber: canonicalInteger(
                  required(values, "deposit-block"),
                  "deposit-block",
                ),
              })
            : (() => {
                throw new TypeError("--operation is unsupported");
              })();
  }
  const artifact = Object.freeze({
    schema: "ckb-automata/dao-harvest-recovery/v1",
    network: deployment.network,
    genesisHash: deployment.genesisHash,
    deploymentManifestSha256: deployment.manifestSha256,
    operation,
    intent: build.intent,
    signingEntries: build.signingEntries,
    transaction: build.transaction,
  });
  const output = required(values, "output");
  await writeFileImpl(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
  return Object.freeze({ command, operation, output, intent: build.intent });
}
