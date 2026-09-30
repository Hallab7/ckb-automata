import { DaoHarvestPayloadV1, JobDataV1 } from "@ckb-automata/molecule";
import type { ClientBlock } from "@ckb-ccc/shell";
import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  addEpochFractions,
  decodeAbsoluteEpochSince,
  decodeRelativeEpochSince,
  encodeAbsoluteEpochSince,
  deriveDaoHarvestPayloadHash,
  hash32FromBytes,
  hash32ToBytes,
  parseEpoch,
  parseHash32,
  parseOutputIndex,
  parseShannons,
  subtractEpochFractions,
  type DaoHarvestDeployment,
  type Hash32,
  type OutputIndex,
  type Shannons,
} from "@ckb-automata/core";

export interface DaoHarvestProjection {
  readonly networkId: string;
  readonly jobId: Hash32;
  readonly ownerLockHash: Hash32;
  readonly payoutLockHash: Hash32;
  readonly vaultOutPoint: { readonly txHash: Hash32; readonly index: OutputIndex };
  readonly vaultState: "deposited" | "withdrawing";
  readonly principalCapacity: Shannons;
  readonly depositEpochSince: bigint;
  readonly prepareStartSince: bigint;
  readonly prepareCutoffSince: bigint;
  readonly claimMaturitySince: bigint | null;
  readonly completedCycles: bigint;
  readonly totalCycles: bigint;
  readonly payload: `0x${string}`;
  readonly provenance: {
    readonly blockNumber: bigint;
    readonly blockHash: Hash32;
    readonly transactionIndex: OutputIndex;
  };
}

export interface DaoHarvestProjectionExtraction {
  readonly projections: readonly DaoHarvestProjection[];
  readonly malformed: number;
}

function witnessOutputType(witness: string): Uint8Array | null {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(witness)) return null;
  const bytes = hexToBytes(witness);
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0, true);
  const outputOffset = view.getUint32(12, true);
  if (total !== bytes.length || outputOffset > total) return null;
  const field = bytes.slice(outputOffset);
  if (field.length < 4) return null;
  const length = new DataView(field.buffer, field.byteOffset, field.byteLength).getUint32(0, true);
  return length === field.length - 4 ? field.slice(4) : null;
}

function scriptsMatch(
  actual:
    | { readonly codeHash: string; readonly hashType: string; readonly args: string }
    | null
    | undefined,
  expected: { readonly codeHash: string; readonly hashType: string },
  args?: string,
): boolean {
  return (
    actual?.codeHash === expected.codeHash &&
    actual.hashType === expected.hashType &&
    (args === undefined || actual.args === args)
  );
}

function payloadFromEnvelope(envelope: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly decoded: ReturnType<typeof DaoHarvestPayloadV1.unpack>;
} {
  if (envelope.length < 4) throw new Error("missing DAO harvest payload");
  const size = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).getUint32(
    0,
    true,
  );
  if (size < 4 || size > envelope.length) throw new Error("invalid DAO harvest payload size");
  const bytes = envelope.slice(0, size);
  return { bytes, decoded: DaoHarvestPayloadV1.unpack(bytes) };
}

export function extractDaoHarvestProjections(
  block: ClientBlock,
  deployment: DaoHarvestDeployment,
): DaoHarvestProjectionExtraction {
  const projections: DaoHarvestProjection[] = [];
  let malformed = 0;
  const blockHash = parseHash32(block.header.hash);
  const blockNumber = BigInt(block.header.number);
  for (const [transactionIndexValue, transaction] of block.transactions.entries()) {
    const transactionIndex = parseOutputIndex(BigInt(transactionIndexValue));
    const txHash = parseHash32(transaction.hash());
    const envelope = witnessOutputType(String(transaction.witnesses[0] ?? "0x"));
    if (!envelope) continue;
    let payload: ReturnType<typeof payloadFromEnvelope>;
    try {
      payload = payloadFromEnvelope(envelope);
    } catch {
      continue;
    }
    for (const [jobIndex, output] of transaction.outputs.entries()) {
      const policyScript = output.type;
      if (
        !scriptsMatch(output.lock, deployment.jobLock.script, "0x") ||
        !scriptsMatch(policyScript, deployment.policy.script, "0x")
      ) {
        continue;
      }
      try {
        const jobData = transaction.outputsData[jobIndex];
        if (!jobData) throw new Error("missing job data");
        const job = JobDataV1.unpack(hexToBytes(jobData));
        const payloadHash = hash32FromBytes(Uint8Array.from(job.payload_hash));
        if (!policyScript) throw new Error("missing policy script");
        const policyHash = parseHash32(scriptToHash(policyScript));
        const expectedPayloadHash = hash32FromBytes(
          deriveDaoHarvestPayloadHash(hash32ToBytes(policyHash), payload.bytes),
        );
        if (payloadHash !== expectedPayloadHash) throw new Error("payload commitment mismatch");
        const expectedVaultHash = bytesToHex(Uint8Array.from(payload.decoded.vault_lock_hash));
        const expectedDaoHash = bytesToHex(Uint8Array.from(payload.decoded.dao_type_hash));
        const vaultIndexes = transaction.outputs.flatMap((candidate, index) =>
          scriptToHash(candidate.lock) === expectedVaultHash &&
          candidate.type !== undefined &&
          scriptToHash(candidate.type) === expectedDaoHash
            ? [index]
            : [],
        );
        if (vaultIndexes.length !== 1) throw new Error("ambiguous vault output");
        const vaultIndex = vaultIndexes[0]!;
        const vaultOutput = transaction.outputs[vaultIndex]!;
        const vaultData = hexToBytes(transaction.outputsData[vaultIndex] ?? "0x");
        if (vaultData.length !== 8) throw new Error("invalid DAO data");
        const prepareStartSince = BigInt(job.not_before.toString());
        const start = decodeAbsoluteEpochSince(prepareStartSince);
        const buffer = decodeRelativeEpochSince(payload.decoded.prepare_buffer_epochs.toString());
        const margin = decodeRelativeEpochSince(
          payload.decoded.confirmation_margin_epochs.toString(),
        );
        const boundary = addEpochFractions(start, buffer);
        const cutoff = subtractEpochFractions(boundary, margin);
        const sequence = BigInt(job.sequence.toString());
        projections.push(
          Object.freeze({
            networkId: deployment.network,
            jobId: hash32FromBytes(Uint8Array.from(job.job_id)),
            ownerLockHash: hash32FromBytes(Uint8Array.from(payload.decoded.owner_lock_hash)),
            payoutLockHash: hash32FromBytes(Uint8Array.from(payload.decoded.payout_lock_hash)),
            vaultOutPoint: Object.freeze({ txHash, index: parseOutputIndex(BigInt(vaultIndex)) }),
            vaultState: vaultData.every((byte) => byte === 0) ? "deposited" : "withdrawing",
            principalCapacity: parseShannons(vaultOutput.capacity.toString()),
            depositEpochSince: encodeAbsoluteEpochSince(parseEpoch(block.header.epoch.toString())),
            prepareStartSince,
            prepareCutoffSince: encodeAbsoluteEpochSince(cutoff),
            claimMaturitySince: sequence % 2n === 1n ? prepareStartSince : null,
            completedCycles: sequence / 2n,
            totalCycles: BigInt(payload.decoded.total_cycles.toString()),
            payload: bytesToHex(payload.bytes) as `0x${string}`,
            provenance: Object.freeze({ blockNumber, blockHash, transactionIndex }),
          }),
        );
      } catch {
        malformed += 1;
      }
    }
  }
  return Object.freeze({ projections: Object.freeze(projections), malformed });
}
