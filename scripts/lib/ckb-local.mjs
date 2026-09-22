import { createRequire } from "node:module";

const requireFromCore = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const {
  ECPair,
  EMPTY_SECP_SIG,
  PERSONAL,
  blake2b,
  bytesToHex,
  hexToBytes,
  rawTransactionToHash,
  scriptToHash,
  serializeWitnessArgs,
} = requireFromCore("@nervosnetwork/ckb-sdk-utils");

export const LOCAL_PRIVATE_KEY = `0x${"01".repeat(32)}`;
export const LOCAL_LOCK_ARG = "0xb6ac779881b4fe05a167e413ff534469b6b5f6c0";
export const SHANNONS_PER_BYTE = 100_000_000n;

function scriptBytes(script) {
  return 33 + (script.args.length - 2) / 2;
}

export function ckbHash(value) {
  const bytes = typeof value === "string" ? hexToBytes(value) : value;
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(bytes);
  return `0x${hasher.digest("hex")}`;
}

export function scriptHash(script) {
  return scriptToHash(script);
}

export function littleEndian(value, byteLength) {
  let remaining = BigInt(value);
  const result = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new RangeError(`${value} does not fit in ${byteLength} bytes`);
  return result;
}

export function concatBytes(...values) {
  const result = new Uint8Array(values.reduce((size, value) => size + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

export function occupiedShannons(output, data) {
  const dataBytes = typeof data === "string" ? (data.length - 2) / 2 : data.length;
  const occupiedBytes =
    8 + scriptBytes(output.lock) + (output.type ? scriptBytes(output.type) : 0) + dataBytes;
  return BigInt(occupiedBytes) * SHANNONS_PER_BYTE;
}

export function signSingleInput(transaction, witnessArgs, privateKey = LOCAL_PRIVATE_KEY) {
  const zeroedWitness = serializeWitnessArgs({ ...witnessArgs, lock: EMPTY_SECP_SIG });
  const txHash = rawTransactionToHash(transaction);
  const signingHasher = blake2b(32, null, null, PERSONAL);
  signingHasher.update(hexToBytes(txHash));
  const witnessBytes = hexToBytes(zeroedWitness);
  signingHasher.update(littleEndian(witnessBytes.length, 8));
  signingHasher.update(witnessBytes);
  const signature = new ECPair(privateKey).signRecoverable(signingHasher.digest());
  return {
    ...transaction,
    witnesses: [serializeWitnessArgs({ ...witnessArgs, lock: signature })],
  };
}

export function toRpcTransaction(transaction) {
  return {
    version: transaction.version,
    cell_deps: transaction.cellDeps.map((dependency) => ({
      out_point: {
        tx_hash: dependency.outPoint.txHash,
        index: dependency.outPoint.index,
      },
      dep_type: dependency.depType === "depGroup" ? "dep_group" : "code",
    })),
    header_deps: transaction.headerDeps,
    inputs: transaction.inputs.map((input) => ({
      since: input.since,
      previous_output: {
        tx_hash: input.previousOutput.txHash,
        index: input.previousOutput.index,
      },
    })),
    outputs: transaction.outputs.map((output) => ({
      capacity: output.capacity,
      lock: toRpcScript(output.lock),
      type: output.type ? toRpcScript(output.type) : null,
    })),
    outputs_data: transaction.outputsData,
    witnesses: transaction.witnesses,
  };
}

function toRpcScript(script) {
  return { code_hash: script.codeHash, hash_type: script.hashType, args: script.args };
}

function fromRpcScript(script) {
  if (!script) return null;
  return { codeHash: script.code_hash, hashType: script.hash_type, args: script.args };
}

export function parseDepGroup(data) {
  const bytes = hexToBytes(data);
  if (bytes.length < 4) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (bytes.length !== 4 + count * 36) return [];
  return Array.from({ length: count }, (_, index) => {
    const offset = 4 + index * 36;
    return {
      txHash: bytesToHex(bytes.slice(offset, offset + 32)),
      index: `0x${view.getUint32(offset + 32, true).toString(16)}`,
    };
  });
}

export function discoverGenesis(block) {
  let funding;
  const cells = [];
  for (const transaction of block.transactions) {
    transaction.outputs.forEach((output, outputIndex) => {
      const outPoint = { txHash: transaction.hash, index: `0x${outputIndex.toString(16)}` };
      const normalized = {
        capacity: output.capacity,
        lock: fromRpcScript(output.lock),
        type: fromRpcScript(output.type),
      };
      const data = transaction.outputs_data[outputIndex];
      cells.push({ data, outPoint, output: normalized });
      if (normalized.lock.args === LOCAL_LOCK_ARG)
        funding ??= { ...outPoint, capacity: output.capacity };
    });
  }
  if (!funding) throw new Error("deterministic genesis funding cell was not found");

  const lockCodeHash = cells.find(({ output }) => output.lock.args === LOCAL_LOCK_ARG).output.lock
    .codeHash;
  const lockCodeCell = cells.find(
    ({ output }) => output.type && scriptToHash(output.type) === lockCodeHash,
  );
  if (!lockCodeCell) throw new Error("genesis secp256k1 lock code cell was not found");

  const depGroupCell = cells.find(({ data }) =>
    parseDepGroup(data).some(
      (outPoint) =>
        outPoint.txHash === lockCodeCell.outPoint.txHash &&
        outPoint.index === lockCodeCell.outPoint.index,
    ),
  );
  if (!depGroupCell) throw new Error("genesis secp256k1 dependency group was not found");

  return {
    funding,
    lock: { codeHash: lockCodeHash, hashType: "type", args: LOCAL_LOCK_ARG },
    secpCellDep: { outPoint: depGroupCell.outPoint, depType: "depGroup" },
  };
}
