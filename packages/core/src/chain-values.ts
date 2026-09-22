declare const chainValueBrand: unique symbol;

type BrandedBigInt<Name extends string> = bigint & { readonly [chainValueBrand]: Name };
type BrandedString<Name extends string> = string & { readonly [chainValueBrand]: Name };

export type Shannons = BrandedBigInt<"Shannons">;
export type BlockNumber = BrandedBigInt<"BlockNumber">;
export type Sequence = BrandedBigInt<"Sequence">;
export type RunCount = BrandedBigInt<"RunCount">;
export type OutputIndex = BrandedBigInt<"OutputIndex">;
export type EpochNumber = BrandedBigInt<"EpochNumber">;
export type EpochIndex = BrandedBigInt<"EpochIndex">;
export type EpochLength = BrandedBigInt<"EpochLength">;
export type EpochValue = BrandedBigInt<"EpochValue">;
export type Hash32 = BrandedString<"Hash32">;
export type IntegerInput = bigint | string;

export type Uint64Value = Shannons | BlockNumber | Sequence;
export type Uint32Value = RunCount | OutputIndex;

export interface Epoch {
  readonly number: EpochNumber;
  readonly index: EpochIndex;
  readonly length: EpochLength;
}

export interface OutPoint {
  readonly txHash: Hash32;
  readonly index: OutputIndex;
}

export interface RpcOutPoint {
  readonly tx_hash: Hash32;
  readonly index: `0x${string}`;
}

export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_UINT32 = (1n << 32n) - 1n;
export const MAX_EPOCH_NUMBER = (1n << 24n) - 1n;
export const MAX_EPOCH_COMPONENT = (1n << 16n) - 1n;
export const MAX_EPOCH_VALUE = (1n << 56n) - 1n;

function parseUnsigned(value: unknown, name: string, maximum: bigint): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "string") {
    if (/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) || /^(?:0|[1-9][0-9]*)$/.test(value)) {
      parsed = BigInt(value);
    } else {
      throw new TypeError(`${name} must be a canonical decimal or lowercase hexadecimal integer`);
    }
  } else {
    throw new TypeError(`${name} must be supplied as bigint or a canonical integer string`);
  }
  if (parsed < 0n || parsed > maximum) {
    throw new RangeError(`${name} must be between 0 and ${maximum}`);
  }
  return parsed;
}

export function parseShannons(value: IntegerInput): Shannons {
  return parseUnsigned(value, "shannons", MAX_UINT64) as Shannons;
}

export function parseBlockNumber(value: IntegerInput): BlockNumber {
  return parseUnsigned(value, "block number", MAX_UINT64) as BlockNumber;
}

export function parseSequence(value: IntegerInput): Sequence {
  return parseUnsigned(value, "sequence", MAX_UINT64) as Sequence;
}

export function parseRunCount(value: IntegerInput): RunCount {
  return parseUnsigned(value, "run count", MAX_UINT32) as RunCount;
}

export function parseOutputIndex(value: IntegerInput): OutputIndex {
  return parseUnsigned(value, "output index", MAX_UINT32) as OutputIndex;
}

export function parseEpochNumber(value: IntegerInput): EpochNumber {
  return parseUnsigned(value, "epoch number", MAX_EPOCH_NUMBER) as EpochNumber;
}

export function parseEpochIndex(value: IntegerInput): EpochIndex {
  return parseUnsigned(value, "epoch index", MAX_EPOCH_COMPONENT) as EpochIndex;
}

export function parseEpochLength(value: IntegerInput): EpochLength {
  return parseUnsigned(value, "epoch length", MAX_EPOCH_COMPONENT) as EpochLength;
}

export function createEpoch(value: {
  readonly number: IntegerInput;
  readonly index: IntegerInput;
  readonly length: IntegerInput;
}): Epoch {
  const epoch = {
    number: parseEpochNumber(value.number),
    index: parseEpochIndex(value.index),
    length: parseEpochLength(value.length),
  };
  const zeroFraction = epoch.length === 0n && epoch.index === 0n;
  if (!zeroFraction && (epoch.length === 0n || epoch.index >= epoch.length)) {
    throw new RangeError("epoch index must be below length, or both must be zero");
  }
  return Object.freeze(epoch);
}

export function packEpoch(epoch: Epoch): EpochValue {
  return (epoch.number | (epoch.index << 24n) | (epoch.length << 40n)) as EpochValue;
}

export function parseEpoch(value: IntegerInput): Epoch {
  const packed = parseUnsigned(value, "epoch", MAX_EPOCH_VALUE);
  return createEpoch({
    number: packed & MAX_EPOCH_NUMBER,
    index: (packed >> 24n) & MAX_EPOCH_COMPONENT,
    length: (packed >> 40n) & MAX_EPOCH_COMPONENT,
  });
}

export function parseHash32(value: string): Hash32 {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("hash must be 0x-prefixed lowercase hexadecimal with exactly 32 bytes");
  }
  return value as Hash32;
}

export function hash32FromBytes(value: Uint8Array): Hash32 {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RangeError("hash bytes must contain exactly 32 bytes");
  }
  return parseHash32(
    `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}

export function hash32ToBytes(value: Hash32): Uint8Array {
  const hash = parseHash32(value);
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(hash.slice(2 + index * 2, 4 + index * 2), 16),
  );
}

export function parseOutPoint(value: unknown): OutPoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("outpoint must be an object with txHash and index");
  }
  const keys = Object.keys(value).toSorted();
  if (keys.length !== 2 || keys[0] !== "index" || keys[1] !== "txHash") {
    throw new TypeError("outpoint must contain only txHash and index");
  }
  const candidate = value as Record<string, unknown>;
  const txHash = candidate["txHash"];
  const index = candidate["index"];
  if (typeof txHash !== "string" || (typeof index !== "string" && typeof index !== "bigint")) {
    throw new TypeError("outpoint txHash and index have invalid types");
  }
  return Object.freeze({
    txHash: parseHash32(txHash),
    index: parseOutputIndex(index),
  });
}

export function toRpcHex(value: Uint64Value | Uint32Value | EpochValue): `0x${string}` {
  return `0x${value.toString(16)}`;
}

export function outPointToRpc(value: OutPoint): RpcOutPoint {
  return Object.freeze({ tx_hash: value.txHash, index: toRpcHex(value.index) });
}

function toLittleEndian(value: bigint, byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let remaining = value;
  for (let index = 0; index < byteLength; index += 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

export function uint64ToLittleEndian(value: Uint64Value): Uint8Array {
  return toLittleEndian(value, 8);
}

export function uint32ToLittleEndian(value: Uint32Value): Uint8Array {
  return toLittleEndian(value, 4);
}
