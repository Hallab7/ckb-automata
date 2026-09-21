import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

export const JOB_ID_DOMAIN = "ckb-automata/job-id/v1" as const;

const BYTE32_LENGTH = 32;
const MAX_UINT16 = 0xffff;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

export type CreationAnchor =
  | { readonly kind: "output_index"; readonly outputIndex: bigint }
  | { readonly kind: "type_id"; readonly typeId: Uint8Array };

export interface JobIdentityInput {
  readonly genesisHash: Uint8Array;
  readonly protocolVersion: number;
  readonly creationCommitment: Uint8Array;
  readonly anchor: CreationAnchor;
  readonly creatorNonce: bigint;
  readonly policyScriptHash: Uint8Array;
}

function requireByte32(value: Uint8Array, name: string): Uint8Array {
  if (value.length !== BYTE32_LENGTH) {
    throw new RangeError(`${name} must contain exactly 32 bytes`);
  }
  return value;
}

function uint16Le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT16) {
    throw new RangeError("protocolVersion must be an unsigned 16-bit integer");
  }
  const encoded = new Uint8Array(2);
  new DataView(encoded.buffer).setUint16(0, value, true);
  return encoded;
}

function uint64Le(value: bigint, name: string): Uint8Array {
  if (value < 0n || value > MAX_UINT64) {
    throw new RangeError(`${name} must be an unsigned 64-bit integer`);
  }
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, value, true);
  return encoded;
}

function anchorParts(anchor: CreationAnchor): readonly Uint8Array[] {
  switch (anchor.kind) {
    case "output_index":
      return [Uint8Array.of(0), uint64Le(anchor.outputIndex, "outputIndex")];
    case "type_id":
      return [Uint8Array.of(1), requireByte32(anchor.typeId, "typeId")];
  }
}

export function deriveJobId(input: JobIdentityInput): Uint8Array {
  const bodyParts = [
    requireByte32(input.genesisHash, "genesisHash"),
    uint16Le(input.protocolVersion),
    requireByte32(input.creationCommitment, "creationCommitment"),
    ...anchorParts(input.anchor),
    uint64Le(input.creatorNonce, "creatorNonce"),
    requireByte32(input.policyScriptHash, "policyScriptHash"),
  ];
  const bodyLength = bodyParts.reduce((total, part) => total + part.length, 0);
  const encodedLength = new Uint8Array(4);
  new DataView(encodedLength.buffer).setUint32(0, bodyLength, true);

  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(JOB_ID_DOMAIN));
  hasher.update(Uint8Array.of(0));
  hasher.update(encodedLength);
  for (const part of bodyParts) {
    hasher.update(part);
  }
  return hasher.digest("binary") as Uint8Array;
}
