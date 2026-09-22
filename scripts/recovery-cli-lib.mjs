import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  buildCancellation,
  buildRecovery,
  createDeploymentRegistry,
  hashDeploymentManifest,
  inspectJobData,
  parseHash32,
  parseOutPoint,
  validateDeploymentManifest,
} from "../packages/core/src/index.ts";

function json(value) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function requireOption(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`--${name.replaceAll("_", "-")} is required`);
  }
  return value;
}

function parseJobOutPoint(value) {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new TypeError("--out-point must use TX_HASH:INDEX");
  }
  return parseOutPoint({ txHash: value.slice(0, separator), index: value.slice(separator + 1) });
}

function fromRpcScript(value) {
  if (!value) return null;
  return {
    codeHash: value.code_hash,
    hashType: value.hash_type,
    args: value.args,
  };
}

async function loadOwnerLock(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.codeHash !== "string" ||
    !["data", "type", "data1"].includes(value.hashType) ||
    typeof value.args !== "string" ||
    !/^0x(?:[0-9a-f]{2})*$/.test(value.args)
  ) {
    throw new TypeError("owner lock file must contain canonical codeHash, hashType, and args");
  }
  return Object.freeze({
    codeHash: parseHash32(value.codeHash),
    hashType: value.hashType,
    args: value.args,
  });
}

async function loadDeployment(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const validated = validateDeploymentManifest(manifest);
  if (validated.status !== "ok") {
    throw new Error(
      `deployment manifest is invalid: ${validated.issues.map((issue) => issue.path).join(", ")}`,
    );
  }
  const digest = await hashDeploymentManifest(manifest);
  const registry = createDeploymentRegistry([
    {
      genesisHash: validated.manifest.genesisHash,
      manifestSha256: digest,
      manifest,
      confirmationDepth: 1,
    },
  ]);
  const loaded = await registry.load(validated.manifest.genesisHash);
  if (loaded.status !== "ok")
    throw new Error(`deployment manifest failed to load (${loaded.status})`);
  return loaded.deployment;
}

function createRpc(urlValue, fetchImpl) {
  const url = new URL(urlValue);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("RPC URL must use http or https");
  }
  if (url.username || url.password) {
    throw new TypeError("RPC URL must not contain credentials");
  }
  let id = 0;
  return async (method, params = []) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ++id, jsonrpc: "2.0", method, params }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(`${method}: ${payload.error?.message ?? `HTTP ${response.status}`}`);
    }
    return payload.result;
  };
}

async function loadLiveCell(rpc, outPoint) {
  const result = await rpc("get_live_cell", [
    { tx_hash: outPoint.txHash, index: `0x${outPoint.index.toString(16)}` },
    true,
  ]);
  if (result?.status !== "live") return null;
  return Object.freeze({
    outPoint,
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
      manifest: { type: "string" },
      "rpc-url": { type: "string" },
      "out-point": { type: "string" },
      "owner-lock": { type: "string" },
      reason: { type: "string" },
      mode: { type: "string" },
      output: { type: "string" },
    },
  });
  if (parsed.positionals.length !== 1) {
    throw new TypeError("select exactly one command: inspect, cancel, recover, or unsigned-export");
  }
  const command = parsed.positionals[0];
  if (!["inspect", "cancel", "recover", "unsigned-export"].includes(command)) {
    throw new TypeError(`unknown recovery command: ${command}`);
  }
  return { command, values: parsed.values };
}

function supportedReason(value) {
  if (
    value !== "unsupported_metadata" &&
    value !== "invalid_application_state" &&
    value !== "terminal_operational_failure"
  ) {
    throw new TypeError(
      "--reason must be unsupported_metadata, invalid_application_state, or terminal_operational_failure",
    );
  }
  return value;
}

async function buildOperation(command, values, deployment, resolver, jobOutPoint) {
  const ownerLock = await loadOwnerLock(requireOption(values, "owner-lock"));
  if (command === "cancel") {
    const build = await buildCancellation({ deployment, resolver, jobOutPoint, ownerLock });
    return {
      operation: "cancel",
      jobId: build.jobId,
      ownerLockHash: build.ownerLockHash,
      preview: {
        refundCapacity: build.refundCapacity,
        paysExecutorReward: false,
        createsSuccessor: false,
      },
      transaction: build.transaction,
      completion: build.completion,
    };
  }
  const reason = supportedReason(requireOption(values, "reason"));
  const build = await buildRecovery({ deployment, resolver, jobOutPoint, ownerLock, reason });
  return {
    operation: "recover",
    jobId: build.preview.jobId,
    ownerLockHash: build.ownerLockHash,
    preview: build.preview,
    transaction: build.transaction,
    completion: build.completion,
  };
}

export async function executeRecoveryCli(
  argv,
  { fetchImpl = globalThis.fetch, writeFileImpl = writeFile } = {},
) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const { command, values } = parseCommand(argv);
  const deployment = await loadDeployment(requireOption(values, "manifest"));
  const rpcUrl = typeof values["rpc-url"] === "string" ? values["rpc-url"] : deployment.rpcUrl;
  const rpc = createRpc(rpcUrl, fetchImpl);
  const remoteGenesis = parseHash32(await rpc("get_block_hash", ["0x0"]));
  if (remoteGenesis !== deployment.genesisHash) {
    throw new Error(
      `RPC genesis ${remoteGenesis} does not match manifest genesis ${deployment.genesisHash}`,
    );
  }
  const jobOutPoint = parseJobOutPoint(requireOption(values, "out-point"));
  const resolver = Object.freeze({ resolve: (outPoint) => loadLiveCell(rpc, outPoint) });
  const live = await resolver.resolve(jobOutPoint);
  if (!live) throw new Error(`Job Cell ${jobOutPoint.txHash}:${jobOutPoint.index} is not live`);

  if (command === "inspect") {
    const inspection = inspectJobData(live.data, {
      manifest: deployment.manifest,
      expectedGenesisHash: deployment.genesisHash,
      ...(live.output.type ? { policyScript: live.output.type } : {}),
    });
    return Object.freeze({
      command,
      network: deployment.network,
      genesisHash: deployment.genesisHash,
      manifestSha256: deployment.manifestSha256,
      rpcUrl,
      cell: live,
      inspection,
    });
  }

  if (command === "cancel" || command === "recover") {
    return Object.freeze({
      command,
      network: deployment.network,
      genesisHash: deployment.genesisHash,
      manifestSha256: deployment.manifestSha256,
      ...(await buildOperation(command, values, deployment, resolver, jobOutPoint)),
    });
  }

  const mode = requireOption(values, "mode");
  if (mode !== "cancel" && mode !== "recover") {
    throw new TypeError("--mode must be cancel or recover");
  }
  const artifact = Object.freeze({
    schemaVersion: 1,
    network: deployment.network,
    genesisHash: deployment.genesisHash,
    manifestSha256: deployment.manifestSha256,
    rpcUrl,
    jobOutPoint,
    ...(await buildOperation(mode, values, deployment, resolver, jobOutPoint)),
  });
  const output = requireOption(values, "output");
  await writeFileImpl(output, `${json(artifact)}\n`, { flag: "wx" });
  return Object.freeze({
    command,
    operation: mode,
    output,
    jobId: artifact.jobId,
    manifestSha256: deployment.manifestSha256,
  });
}

export function formatRecoveryCliResult(value) {
  return `${json(value)}\n`;
}
