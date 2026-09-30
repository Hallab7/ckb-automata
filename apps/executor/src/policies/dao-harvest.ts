import { DaoHarvestPayloadV1, type DaoHarvestPayloadV1Value } from "@ckb-automata/molecule";
import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  addEpochFractions,
  addEpochs,
  buildDaoHarvestPrepare,
  buildDaoHarvestRoll,
  compareEpochFractions,
  decodeAbsoluteEpochSince,
  decodeRelativeEpochSince,
  deriveDaoHarvestPayloadHash,
  encodeAbsoluteEpochSince,
  hash32FromBytes,
  hash32ToBytes,
  minimumPlainCellCapacity,
  parseEpoch,
  parseHash32,
  parseShannons,
  registeredDaoHarvestDeployment,
  selectDaoPrepareWindow,
  subtractEpochFractions,
  type Hash32,
  type ScriptIdentity,
} from "@ckb-automata/core";

import {
  defineExecutorAdapter,
  type EligibilityDecision,
  type ExecutorAdapterRegistration,
  type ExecutorBuild,
  type ExecutorCellSnapshot,
  type ExecutorContext,
  type ExecutorEligibilityContext,
} from "../adapter.ts";

type Hex = `0x${string}`;

export class DaoHarvestAdapterError extends Error {
  override readonly name = "DaoHarvestAdapterError";
  readonly code:
    | "EXECUTOR_FEE_INPUT_UNAVAILABLE"
    | "EXECUTOR_INVALID_APPLICATION_STATE"
    | "EXECUTOR_MISSING_HEADER"
    | "EXECUTOR_PAYLOAD_HASH_MISMATCH"
    | "EXECUTOR_PREPARE_WINDOW_MISSED";

  constructor(code: DaoHarvestAdapterError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface DaoHarvestEvidence {
  readonly observedEpoch: string;
  readonly notBefore: string;
  readonly operation: "prepare" | "roll";
}

interface DaoHarvestInspection {
  readonly payload: DaoHarvestPayloadV1Value;
  readonly payloadHex: Hex;
  readonly vault: ExecutorCellSnapshot;
  readonly feeCell: ExecutorCellSnapshot;
  readonly ownerLock: ScriptIdentity;
  readonly payoutLock: ScriptIdentity;
  readonly operation: "prepare" | "roll";
  readonly boundarySince: bigint;
  readonly cutoffSince: bigint;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function scriptHash(script: ScriptIdentity): Hash32 {
  return parseHash32(scriptToHash(script));
}

function preliminaryEligibility(
  context: ExecutorEligibilityContext,
): EligibilityDecision<DaoHarvestEvidence> {
  const tip = parseEpoch(context.snapshot.tip.epoch);
  const notBefore = decodeAbsoluteEpochSince(context.jobInspection.job.notBefore);
  const operation = context.jobInspection.job.sequence % 2n === 0n ? "prepare" : "roll";
  const evidence = Object.freeze({
    observedEpoch: context.snapshot.tip.epoch,
    notBefore: context.jobInspection.job.notBefore.toString(),
    operation,
  });
  return compareEpochFractions(tip, notBefore) >= 0
    ? Object.freeze({ status: "eligible", evidence })
    : Object.freeze({
        status: "ineligible",
        reason: "EXECUTOR_NOT_YET_ELIGIBLE",
        terminal: false,
        evidence,
      });
}

export const DAO_HARVEST_EXECUTOR_REGISTRATION = Object.freeze({
  id: "dao-harvest-v1",
  policy: "dao-harvest",
  supports: (policy) => policy.kind === "dao_harvest",
  evaluateEligibility: preliminaryEligibility,
} satisfies ExecutorAdapterRegistration);

function payloadFromEnvelope(value: Hex): Hex {
  const bytes = hexToBytes(value);
  if (bytes.length < 4) throw new Error("payload envelope is truncated");
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (size < 4 || size > bytes.length) throw new Error("payload envelope size is invalid");
  return bytesToHex(bytes.slice(0, size)) as Hex;
}

function resolvePayload(context: ExecutorContext): {
  readonly value: DaoHarvestPayloadV1Value;
  readonly hex: Hex;
} {
  const policyHash = hash32ToBytes(context.jobInspection.job.policyScriptHash);
  const matches: { readonly value: DaoHarvestPayloadV1Value; readonly hex: Hex }[] = [];
  for (const envelope of new Set(context.snapshot.payloads)) {
    try {
      const hex = payloadFromEnvelope(envelope);
      const bytes = hexToBytes(hex);
      if (
        hash32FromBytes(deriveDaoHarvestPayloadHash(policyHash, bytes)) !==
        context.jobInspection.job.payloadHash
      ) {
        continue;
      }
      matches.push({ value: DaoHarvestPayloadV1.unpack(bytes), hex });
    } catch {
      // Unrelated witness output types are not evidence for this job.
    }
  }
  if (matches.length !== 1) {
    throw new DaoHarvestAdapterError(
      "EXECUTOR_PAYLOAD_HASH_MISMATCH",
      "the snapshot does not contain one committed DAO harvest payload",
    );
  }
  return matches[0]!;
}

function findLock(context: ExecutorContext, hash: Hash32, label: string): ScriptIdentity {
  const matches = new Map(
    context.snapshot.resolvedLocks
      .filter((lock) => scriptHash(lock) === hash)
      .map((lock) => [stable(lock), lock]),
  );
  if (matches.size !== 1) {
    throw new DaoHarvestAdapterError(
      "EXECUTOR_INVALID_APPLICATION_STATE",
      `${label} lock resolution is unavailable or ambiguous`,
    );
  }
  return matches.values().next().value!;
}

function compareCells(left: ExecutorCellSnapshot, right: ExecutorCellSnapshot): number {
  const byHash = left.outPoint.txHash.localeCompare(right.outPoint.txHash);
  return byHash === 0 ? Number(left.outPoint.index - right.outPoint.index) : byHash;
}

function selectFeeCell(context: ExecutorContext): ExecutorCellSnapshot {
  const minimum = minimumPlainCellCapacity(context.identity.rewardLock);
  const candidates = context.snapshot.feeCells
    .filter(
      (cell) =>
        stable(cell.output.lock) === stable(context.identity.rewardLock) &&
        cell.output.type === null &&
        cell.data === "0x" &&
        stable(cell.outPoint) !== stable(context.snapshot.job.outPoint) &&
        !context.snapshot.applicationCells.some(
          (application) => stable(application.outPoint) === stable(cell.outPoint),
        ) &&
        parseShannons(cell.output.capacity) >= context.identity.transactionFee + minimum,
    )
    .toSorted(compareCells);
  if (!candidates[0]) {
    throw new DaoHarvestAdapterError(
      "EXECUTOR_FEE_INPUT_UNAVAILABLE",
      "no plain executor cell can fund the network fee and valid change",
    );
  }
  return candidates[0];
}

function inspectDaoHarvest(context: ExecutorContext): DaoHarvestInspection {
  if (context.jobInspection.policy.kind !== "dao_harvest") {
    throw new DaoHarvestAdapterError(
      "EXECUTOR_INVALID_APPLICATION_STATE",
      "DAO harvest adapter received another policy",
    );
  }
  const resolved = resolvePayload(context);
  const vaultHash = bytesToHex(Uint8Array.from(resolved.value.vault_lock_hash));
  const daoHash = bytesToHex(Uint8Array.from(resolved.value.dao_type_hash));
  const vaults = context.snapshot.applicationCells.filter(
    (cell) =>
      scriptHash(cell.output.lock) === vaultHash &&
      cell.output.type !== null &&
      scriptHash(cell.output.type) === daoHash,
  );
  if (vaults.length !== 1) {
    throw new DaoHarvestAdapterError(
      "EXECUTOR_INVALID_APPLICATION_STATE",
      "the live job must resolve exactly one matching DAO vault",
    );
  }
  const job = context.jobInspection.job;
  const operation = job.sequence % 2n === 0n ? "prepare" : "roll";
  const start = decodeAbsoluteEpochSince(job.notBefore);
  const buffer = decodeRelativeEpochSince(resolved.value.prepare_buffer_epochs.toString());
  const margin = decodeRelativeEpochSince(resolved.value.confirmation_margin_epochs.toString());
  const boundary = addEpochFractions(start, buffer);
  const cutoff = subtractEpochFractions(boundary, margin);
  return Object.freeze({
    payload: resolved.value,
    payloadHex: resolved.hex,
    vault: vaults[0]!,
    feeCell: selectFeeCell(context),
    ownerLock: findLock(
      context,
      hash32FromBytes(Uint8Array.from(resolved.value.owner_lock_hash)),
      "owner",
    ),
    payoutLock: findLock(
      context,
      hash32FromBytes(Uint8Array.from(resolved.value.payout_lock_hash)),
      "payout",
    ),
    operation,
    boundarySince: encodeAbsoluteEpochSince(boundary),
    cutoffSince: encodeAbsoluteEpochSince(cutoff),
  });
}

function fullEligibility(
  context: ExecutorContext,
  inspection: DaoHarvestInspection,
): EligibilityDecision<DaoHarvestEvidence> {
  const basic = preliminaryEligibility(context);
  if (basic.status === "ineligible") return basic;
  if (
    inspection.operation === "prepare" &&
    compareEpochFractions(
      parseEpoch(context.snapshot.tip.epoch),
      decodeAbsoluteEpochSince(inspection.cutoffSince),
    ) >= 0
  ) {
    return Object.freeze({
      status: "ineligible",
      reason: "EXECUTOR_PREPARE_WINDOW_MISSED",
      terminal: true,
      evidence: basic.evidence,
    });
  }
  return basic;
}

function headerRate(value: Hex | undefined): bigint {
  if (!value || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new DaoHarvestAdapterError("EXECUTOR_MISSING_HEADER", "DAO header data is unavailable");
  }
  return Buffer.from(value.slice(2, 18), "hex").readBigUInt64LE();
}

function liveResolver(context: ExecutorContext, inspection: DaoHarvestInspection) {
  const cells = [context.snapshot.job, inspection.vault, inspection.feeCell];
  return Object.freeze({
    resolve: async (outPoint: { readonly txHash: string; readonly index: bigint }) => {
      const cell = cells.find(
        (candidate) =>
          candidate.outPoint.txHash === outPoint.txHash &&
          candidate.outPoint.index === outPoint.index,
      );
      return cell
        ? Object.freeze({
            outPoint: cell.outPoint,
            output: cell.output,
            data: cell.data,
          })
        : null;
    },
  });
}

function findHeader(
  context: ExecutorContext,
  predicate: (number: bigint, hash: string) => boolean,
) {
  const matches = context.snapshot.headers.filter((header) =>
    predicate(header.number, header.hash),
  );
  if (matches.length !== 1) {
    throw new DaoHarvestAdapterError(
      "EXECUTOR_MISSING_HEADER",
      "the required canonical DAO header is unavailable or ambiguous",
    );
  }
  return matches[0]!;
}

async function buildDaoHarvest(
  context: ExecutorContext,
  inspection: DaoHarvestInspection,
): Promise<ExecutorBuild> {
  const deployment = registeredDaoHarvestDeployment(context.snapshot.deployment);
  const authorityLockHash = scriptHash(context.identity.rewardLock);
  const common = {
    deployment,
    expectedGenesisHash: context.snapshot.deployment.genesisHash,
    resolver: liveResolver(context, inspection),
    vaultOutPoint: inspection.vault.outPoint,
    jobOutPoint: context.snapshot.job.outPoint,
    authorityOutPoint: inspection.feeCell.outPoint,
    authorityLock: context.identity.rewardLock,
    authorityLockHash,
    authorityOccupiedCapacity: minimumPlainCellCapacity(context.identity.rewardLock),
    networkFee: context.identity.transactionFee,
    payload: inspection.payloadHex,
    prepareExecutorLockHashes:
      context.snapshot.deployment.manifest.daoHarvest!.prepareExecutorLockHashes,
  } as const;
  if (inspection.operation === "prepare") {
    const result = await buildDaoHarvestPrepare({
      ...common,
      depositHeaderHash: inspection.vault.blockHash,
      depositBlockNumber: inspection.vault.blockNumber,
      claimSince: inspection.boundarySince,
    });
    return Object.freeze({ transaction: result.transaction, summary: result.intent });
  }
  const data = Buffer.from(inspection.vault.data.slice(2), "hex");
  if (data.length !== 8 || data.every((byte) => byte === 0)) {
    throw new DaoHarvestAdapterError(
      "EXECUTOR_INVALID_APPLICATION_STATE",
      "roll requires a withdrawing DAO vault",
    );
  }
  const depositBlock = data.readBigUInt64LE();
  const depositHeader = findHeader(context, (number) => number === depositBlock);
  const prepareHeader = findHeader(context, (_number, hash) => hash === inspection.vault.blockHash);
  const tipEpoch = parseEpoch(context.snapshot.tip.epoch);
  const anticipatedDepositEpoch = addEpochs(tipEpoch, 1n);
  const buffer = decodeRelativeEpochSince(inspection.payload.prepare_buffer_epochs.toString());
  const margin = decodeRelativeEpochSince(inspection.payload.confirmation_margin_epochs.toString());
  const nextWindow = selectDaoPrepareWindow({
    deposit: anticipatedDepositEpoch,
    tip: anticipatedDepositEpoch,
    bufferEpochs: buffer.number,
    confirmationMarginEpochs: margin.number,
  });
  const result = await buildDaoHarvestRoll({
    ...common,
    depositHeaderHash: depositHeader.hash,
    prepareHeaderHash: prepareHeader.hash,
    depositAccumulatedRate: headerRate(depositHeader.dao),
    withdrawingAccumulatedRate: headerRate(prepareHeader.dao),
    vaultOccupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
    payoutOccupiedCapacity: minimumPlainCellCapacity(inspection.payoutLock),
    ...(context.jobInspection.job.remainingRuns > 1n
      ? { nextPrepareSince: encodeAbsoluteEpochSince(nextWindow.startsAt) }
      : {}),
    payoutLock: inspection.payoutLock,
    ownerRefundLock: inspection.ownerLock,
  });
  return Object.freeze({ transaction: result.transaction, summary: result.intent });
}

export const DAO_HARVEST_EXECUTOR_ADAPTER = defineExecutorAdapter<
  DaoHarvestInspection,
  DaoHarvestEvidence
>({
  registration: DAO_HARVEST_EXECUTOR_REGISTRATION,
  inspect: inspectDaoHarvest,
  eligibility: fullEligibility,
  build: buildDaoHarvest,
  verifyBuilt: async (context, inspection, _eligibility, build) => {
    const expected = await buildDaoHarvest(context, inspection);
    return stable(build) === stable(expected)
      ? Object.freeze({ status: "valid" })
      : Object.freeze({
          status: "invalid",
          reason: "EXECUTOR_SIMULATION_REJECTED",
          message: "DAO harvest transaction differs from its live-cell reconstruction",
        });
  },
});
