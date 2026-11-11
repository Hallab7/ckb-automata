import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  DaoHarvestPayloadV3,
  DaoHarvestPrepareCreditV3,
  DaoHarvestProgressV3,
  JobDataV1,
} from "@ckb-automata/molecule";

import {
  hash32FromBytes,
  parseHash32,
  parseShannons,
  type Hash32,
  type IntegerInput,
  type Shannons,
} from "./chain-values.ts";
import { calculateDaoMaximumWithdraw } from "./dao-harvest-math.ts";
import {
  buildDaoHarvestV3FallbackClaim,
  buildDaoHarvestV3FallbackPrepare,
  buildDaoHarvestV3PreferredClaim,
  buildDaoHarvestV3PreferredPrepare,
  type DaoHarvestV3Build,
  type DaoHarvestV3DeploymentIdentity,
  type DaoHarvestV3ReviewedInput,
  type DaoHarvestV3ReviewedOutput,
} from "./dao-harvest-v3-builders.ts";
import {
  DAO_HARVEST_V3_OPERATIONS,
  deriveDaoHarvestV3PayloadHash,
  deriveDaoHarvestV3PrepareCreditHash,
  deriveDaoHarvestV3ProgressHash,
  encodeDaoHarvestV3CompensationLockArgs,
} from "./dao-harvest-v3.ts";
import type { UnsignedCellInput, UnsignedCellOutput } from "./deadline-creation.ts";
import type { ScriptIdentity } from "./job-inspection.ts";

type Hex = `0x${string}`;

export interface DaoHarvestV3TransitionCell {
  readonly outPoint: { readonly txHash: Hash32; readonly index: IntegerInput };
  readonly capacity: IntegerInput;
  readonly lock: ScriptIdentity;
  readonly type: ScriptIdentity | null;
  readonly data: Hex;
}

export type DaoHarvestV3TransitionDeployment = DaoHarvestV3DeploymentIdentity;

interface CommonInput {
  readonly deployment: DaoHarvestV3TransitionDeployment;
  readonly policyScriptHash: Hash32;
  readonly payload: Uint8Array;
  readonly progress: Uint8Array;
  readonly job: DaoHarvestV3TransitionCell;
  readonly vault: DaoHarvestV3TransitionCell;
  readonly accumulator: DaoHarvestV3TransitionCell;
  readonly feeCell: DaoHarvestV3TransitionCell;
  readonly operatorOwnerLock: ScriptIdentity;
  readonly transactionFee: IntegerInput;
  readonly rpcGenesisHash: Hash32;
  readonly canonicalHeaderHashes: readonly Hash32[];
  readonly ownerLock: ScriptIdentity;
}

export interface DaoHarvestV3PrepareTransitionInput extends CommonInput {
  readonly operation: "preferred_prepare" | "fallback_prepare";
  readonly operatorProof?: Uint8Array;
  readonly depositHeaderHash: Hash32;
  readonly depositBlockNumber: IntegerInput;
  readonly executionSince: IntegerInput;
  readonly claimSince: IntegerInput;
}

export interface DaoHarvestV3ClaimTransitionInput extends CommonInput {
  readonly operation: "preferred_claim" | "fallback_claim";
  readonly prepareCredit: Uint8Array;
  readonly compensation: DaoHarvestV3TransitionCell;
  readonly prepareAccumulator: DaoHarvestV3TransitionCell;
  readonly claimAccumulator?: DaoHarvestV3TransitionCell;
  readonly depositHeaderHash: Hash32;
  readonly prepareHeaderHash: Hash32;
  readonly depositAccumulatedRate: IntegerInput;
  readonly prepareAccumulatedRate: IntegerInput;
  readonly vaultOccupiedCapacity: IntegerInput;
  readonly executionSince: IntegerInput;
  readonly nextPrepareSince?: IntegerInput;
}

const ABSENT = 0xffff_ffff;

function txInput(cell: DaoHarvestV3TransitionCell, since: IntegerInput = 0n): UnsignedCellInput {
  return Object.freeze({
    since: `0x${BigInt(since).toString(16)}` as Hex,
    previousOutput: Object.freeze({
      txHash: parseHash32(cell.outPoint.txHash),
      index: `0x${BigInt(cell.outPoint.index).toString(16)}` as Hex,
    }),
  });
}

function txOutput(
  capacity: IntegerInput,
  lock: ScriptIdentity,
  type: ScriptIdentity | null,
): UnsignedCellOutput {
  return Object.freeze({
    capacity: `0x${parseShannons(capacity).toString(16)}` as Hex,
    lock,
    type,
  });
}

function u64(value: IntegerInput): Uint8Array {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) throw new RangeError("uint64 overflow");
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, parsed, true);
  return encoded;
}

function sameLock(left: ScriptIdentity, right: ScriptIdentity): boolean {
  return scriptToHash(left) === scriptToHash(right);
}

function assertPlain(cell: DaoHarvestV3TransitionCell, name: string): void {
  if (cell.type !== null || cell.data !== "0x") throw new Error(`${name} must be a plain cell`);
}

function feeChange(value: CommonInput): Shannons {
  assertPlain(value.feeCell, "executor fee cell");
  if (!sameLock(value.feeCell.lock, value.operatorOwnerLock)) {
    throw new Error("executor fee cell is controlled by another lock");
  }
  const capacity = parseShannons(value.feeCell.capacity);
  const fee = parseShannons(value.transactionFee);
  if (capacity <= fee) throw new RangeError("executor fee cell cannot fund the network fee");
  return parseShannons(capacity - fee);
}

function state(value: CommonInput) {
  const payload = DaoHarvestPayloadV3.unpack(value.payload);
  const progress = DaoHarvestProgressV3.unpack(value.progress);
  const job = JobDataV1.unpack(hexToBytes(value.job.data));
  if (Number(payload.version) !== 3 || Number(progress.version) !== 3) {
    throw new Error("DAO Harvest V3 transition contains another payload version");
  }
  if (
    hash32FromBytes(
      deriveDaoHarvestV3PayloadHash(hexToBytes(value.policyScriptHash), value.payload),
    ) !== hash32FromBytes(Uint8Array.from(job.payload_hash))
  ) {
    throw new Error("live Job Cell does not commit to the supplied V3 payload");
  }
  if (
    hash32FromBytes(deriveDaoHarvestV3ProgressHash(value.progress)) !==
    hash32FromBytes(Uint8Array.from(job.trigger_params_hash))
  ) {
    throw new Error("live Job Cell does not commit to the supplied V3 progress");
  }
  assertPlain(value.accumulator, "operator accumulator");
  return { payload, progress, job };
}

function nextJob(
  current: ReturnType<typeof JobDataV1.unpack>,
  progress: Uint8Array,
  notBefore: IntegerInput,
  remainingRuns: number,
) {
  return JobDataV1.pack({
    ...current,
    sequence: (BigInt(current.sequence.toString()) + 1n).toString(),
    trigger_params_hash: [...deriveDaoHarvestV3ProgressHash(progress)],
    not_before: BigInt(notBefore).toString(),
    remaining_runs: remainingRuns,
  });
}

function reviewedInput(
  cell: DaoHarvestV3TransitionCell,
  since: IntegerInput = 0n,
  capacity: IntegerInput = cell.capacity,
): DaoHarvestV3ReviewedInput {
  return Object.freeze({
    input: txInput(cell, since),
    capacity,
    lockHash: parseHash32(scriptToHash(cell.lock)),
  });
}

function reviewedOutput(
  capacity: IntegerInput,
  lock: ScriptIdentity,
  type: ScriptIdentity | null,
  data: Hex = "0x",
): DaoHarvestV3ReviewedOutput {
  return Object.freeze({ output: txOutput(capacity, lock, type), data });
}

function context(value: CommonInput, cells: readonly DaoHarvestV3TransitionCell[]) {
  return Object.freeze({
    rpcGenesisHash: value.rpcGenesisHash,
    deployment: value.deployment,
    canonicalHeaderHashes: value.canonicalHeaderHashes,
    liveOutPoints: Object.freeze(cells.map((cell) => txInput(cell).previousOutput)),
    signerLockHash: parseHash32(scriptToHash(value.operatorOwnerLock)),
  });
}

export function buildDaoHarvestV3PrepareTransition(
  value: DaoHarvestV3PrepareTransitionInput,
): DaoHarvestV3Build {
  const current = state(value);
  if (Number(current.progress.state) !== 0 || current.progress.prepare_credit_hash.some(Boolean)) {
    throw new Error("prepare requires deposited V3 progress");
  }
  if (value.vault.data !== "0x0000000000000000")
    throw new Error("prepare requires a deposited DAO vault");
  const credit = DaoHarvestPrepareCreditV3.pack({
    version: 3,
    job_id: [...current.job.job_id],
    cycle_index: current.progress.cycle_index,
    preparer_lock_hash: [...hexToBytes(parseHash32(scriptToHash(value.accumulator.lock)))],
    prepared_vault_output_index: 1,
    job_output_index: 0,
  });
  const withdrawing = DaoHarvestProgressV3.pack({
    version: 3,
    state: 1,
    cycle_index: current.progress.cycle_index,
    prepare_credit_hash: [...deriveDaoHarvestV3PrepareCreditHash(credit)],
  });
  const jobData = nextJob(
    current.job,
    withdrawing,
    value.claimSince,
    Number(current.job.remaining_runs),
  );
  const cells = [value.job, value.vault, value.accumulator, value.feeCell] as const;
  const operation =
    value.operation === "preferred_prepare"
      ? DAO_HARVEST_V3_OPERATIONS.PREFERRED_PREPARE
      : DAO_HARVEST_V3_OPERATIONS.FALLBACK_PREPARE;
  if (
    operation === DAO_HARVEST_V3_OPERATIONS.FALLBACK_PREPARE &&
    value.operatorProof === undefined
  ) {
    throw new Error("fallback preparation requires the committed operator proof");
  }
  const build =
    operation === DAO_HARVEST_V3_OPERATIONS.PREFERRED_PREPARE
      ? buildDaoHarvestV3PreferredPrepare
      : buildDaoHarvestV3FallbackPrepare;
  const accumulator = reviewedInput(value.accumulator);
  return build({
    context: context(value, cells),
    policyScriptHash: value.policyScriptHash,
    ownerLockHash: hash32FromBytes(Uint8Array.from(current.payload.owner_lock_hash)),
    payload: value.payload,
    progress: value.progress,
    prepareCredit: credit,
    ...(operation === DAO_HARVEST_V3_OPERATIONS.FALLBACK_PREPARE
      ? { operatorProof: value.operatorProof }
      : {}),
    inputs: {
      job: reviewedInput(value.job, value.executionSince),
      vault: reviewedInput(value.vault),
      identity: accumulator,
      prepareAccumulator: accumulator,
      additional: [reviewedInput(value.feeCell)],
    },
    outputs: {
      job: reviewedOutput(
        value.job.capacity,
        value.job.lock,
        value.job.type,
        bytesToHex(jobData) as Hex,
      ),
      vault: reviewedOutput(
        value.vault.capacity,
        value.vault.lock,
        value.vault.type,
        bytesToHex(u64(value.depositBlockNumber)) as Hex,
      ),
      prepareAccumulator: reviewedOutput(value.accumulator.capacity, value.accumulator.lock, null),
      additional: [reviewedOutput(feeChange(value), value.operatorOwnerLock, null)],
    },
    headerDeps: [value.depositHeaderHash],
    maximumNetworkFee: value.transactionFee,
    allowedFundingLockHashes: [parseHash32(scriptToHash(value.operatorOwnerLock))],
  });
}

function terminalCompensation(lock: ScriptIdentity): ScriptIdentity {
  const args = hexToBytes(lock.args);
  if (args.length !== 160) throw new Error("compensation lock arguments are invalid");
  return Object.freeze({
    ...lock,
    args: bytesToHex(
      encodeDaoHarvestV3CompensationLockArgs({
        jobId: new Uint8Array(32),
        ownerLockHash: args.slice(32, 64),
        payoutLockHash: args.slice(64, 96),
        policyScriptHash: args.slice(96, 128),
        payloadHash: args.slice(128, 160),
      }),
    ) as Hex,
  });
}

export function buildDaoHarvestV3ClaimTransition(
  value: DaoHarvestV3ClaimTransitionInput,
): DaoHarvestV3Build {
  const current = state(value);
  if (Number(current.progress.state) !== 1)
    throw new Error("claim requires withdrawing V3 progress");
  if (
    hash32FromBytes(deriveDaoHarvestV3PrepareCreditHash(value.prepareCredit)) !==
    hash32FromBytes(Uint8Array.from(current.progress.prepare_credit_hash))
  )
    throw new Error("claim prepare credit does not match live progress");
  const credit = DaoHarvestPrepareCreditV3.unpack(value.prepareCredit);
  if (
    hash32FromBytes(Uint8Array.from(credit.job_id)) !==
    hash32FromBytes(Uint8Array.from(current.job.job_id))
  ) {
    throw new Error("claim prepare credit belongs to another job");
  }
  assertPlain(value.compensation, "compensation cell");
  assertPlain(value.prepareAccumulator, "prepare accumulator");
  const claimant = value.claimAccumulator ?? value.accumulator;
  assertPlain(claimant, "claim accumulator");
  const principal = parseShannons(current.payload.principal_capacity.toString());
  const maximum = calculateDaoMaximumWithdraw({
    principal,
    occupiedCapacity: value.vaultOccupiedCapacity,
    depositAccumulatedRate: value.depositAccumulatedRate,
    withdrawingAccumulatedRate: value.prepareAccumulatedRate,
  });
  const gross = maximum - principal;
  const preparePayment =
    gross < BigInt(current.payload.prepare_service_fee.toString())
      ? gross
      : BigInt(current.payload.prepare_service_fee.toString());
  const afterPrepare = gross - preparePayment;
  const claimPayment =
    afterPrepare < BigInt(current.payload.claim_service_fee.toString())
      ? afterPrepare
      : BigInt(current.payload.claim_service_fee.toString());
  const ownerPayment = afterPrepare - claimPayment;
  const terminal = Number(current.job.remaining_runs) === 1;
  if (!terminal && value.nextPrepareSince === undefined)
    throw new Error("a non-terminal claim requires the next preparation time");

  const cells: DaoHarvestV3TransitionCell[] = [
    value.job,
    value.vault,
    value.compensation,
    value.prepareAccumulator,
  ];
  const sameOperator = sameLock(value.prepareAccumulator.lock, claimant.lock);
  if (!sameOperator) {
    cells.push(claimant);
  }
  cells.push(value.feeCell);
  const inputs = cells.map((cell, index) => txInput(cell, index === 1 ? value.executionSince : 0n));
  const outputs: UnsignedCellOutput[] = [];
  const outputsData: Hex[] = [];
  let jobOutput = ABSENT;
  if (!terminal) {
    const deposited = DaoHarvestProgressV3.pack({
      version: 3,
      state: 0,
      cycle_index: Number(current.progress.cycle_index) + 1,
      prepare_credit_hash: Array(32).fill(0),
    });
    jobOutput = outputs.length;
    outputs.push(txOutput(value.job.capacity, value.job.lock, value.job.type));
    outputsData.push(
      bytesToHex(
        nextJob(
          current.job,
          deposited,
          value.nextPrepareSince!,
          Number(current.job.remaining_runs) - 1,
        ),
      ) as Hex,
    );
  }
  outputs.push(
    txOutput(principal, terminal ? value.ownerLock : value.vault.lock, value.vault.type),
  );
  outputsData.push("0x0000000000000000");
  outputs.push(
    txOutput(
      BigInt(value.compensation.capacity) + ownerPayment,
      terminal ? terminalCompensation(value.compensation.lock) : value.compensation.lock,
      null,
    ),
  );
  outputsData.push("0x");
  outputs.push(
    txOutput(
      BigInt(value.prepareAccumulator.capacity) +
        preparePayment +
        (sameOperator ? claimPayment : 0n),
      value.prepareAccumulator.lock,
      null,
    ),
  );
  outputsData.push("0x");
  if (!sameOperator) {
    outputs.push(txOutput(BigInt(claimant.capacity) + claimPayment, claimant.lock, null));
    outputsData.push("0x");
  }
  outputs.push(txOutput(feeChange(value), value.operatorOwnerLock, null));
  outputsData.push("0x");
  const extra: Hex[] = Array.from({ length: inputs.length - 1 }, () => "0x" as Hex);
  extra[0] = serializeWitnessArgs({
    lock: "",
    inputType: bytesToHex(u64(0n)),
    outputType: "",
  }) as Hex;
  const operation =
    value.operation === "preferred_claim"
      ? DAO_HARVEST_V3_OPERATIONS.PREFERRED_CLAIM
      : DAO_HARVEST_V3_OPERATIONS.FALLBACK_CLAIM;
  const build =
    operation === DAO_HARVEST_V3_OPERATIONS.PREFERRED_CLAIM
      ? buildDaoHarvestV3PreferredClaim
      : buildDaoHarvestV3FallbackClaim;
  const prepareInput = reviewedInput(value.prepareAccumulator);
  const identity = sameOperator ? prepareInput : reviewedInput(claimant);
  return build({
    context: context(value, cells),
    policyScriptHash: value.policyScriptHash,
    ownerLockHash: hash32FromBytes(Uint8Array.from(current.payload.owner_lock_hash)),
    payload: value.payload,
    progress: value.progress,
    prepareCredit: value.prepareCredit,
    inputs: {
      job: reviewedInput(value.job),
      vault: reviewedInput(value.vault, value.executionSince, maximum),
      compensation: reviewedInput(value.compensation),
      identity,
      prepareAccumulator: prepareInput,
      ...(!sameOperator ? { claimAccumulator: identity } : {}),
      additional: [reviewedInput(value.feeCell)],
    },
    outputs: {
      ...(!terminal
        ? {
            job: reviewedOutput(
              value.job.capacity,
              value.job.lock,
              value.job.type,
              outputsData[jobOutput]!,
            ),
          }
        : {}),
      vault: reviewedOutput(
        principal,
        terminal ? value.ownerLock : value.vault.lock,
        value.vault.type,
        "0x0000000000000000",
      ),
      compensation: reviewedOutput(
        BigInt(value.compensation.capacity) +
          ownerPayment +
          (terminal ? BigInt(value.job.capacity) : 0n),
        terminal ? terminalCompensation(value.compensation.lock) : value.compensation.lock,
        null,
      ),
      prepareAccumulator: reviewedOutput(
        BigInt(value.prepareAccumulator.capacity) +
          preparePayment +
          (sameOperator ? claimPayment : 0n),
        value.prepareAccumulator.lock,
        null,
      ),
      ...(!sameOperator
        ? {
            claimAccumulator: reviewedOutput(
              BigInt(claimant.capacity) + claimPayment,
              claimant.lock,
              null,
            ),
          }
        : {}),
      additional: [reviewedOutput(feeChange(value), value.operatorOwnerLock, null)],
    },
    headerDeps: [value.depositHeaderHash, value.prepareHeaderHash],
    additionalWitnesses: extra,
    maximumNetworkFee: value.transactionFee,
    allowedFundingLockHashes: [parseHash32(scriptToHash(value.operatorOwnerLock))],
  });
}
