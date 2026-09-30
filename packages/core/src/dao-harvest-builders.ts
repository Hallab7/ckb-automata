import { DaoHarvestPayloadV1, JobDataV1 } from "@ckb-automata/molecule";
import {
  PERSONAL,
  blake2b,
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import type { LiveCellResolver, ResolvedLiveCell } from "./cancellation.ts";
import {
  hash32FromBytes,
  hash32ToBytes,
  parseHash32,
  parseOutPoint,
  parseRunCount,
  parseSequence,
  parseShannons,
  toRpcHex,
  uint64ToLittleEndian,
  type CellDepValue,
  type Hash32,
  type IntegerInput,
  type OutPoint,
  type Shannons,
} from "./chain-values.ts";
import {
  DAO_HARVEST_OPERATIONS,
  deriveDaoHarvestPayloadHash,
  derivePrepareExecutorSetHash,
  normalizePrepareExecutorSet,
} from "./dao-harvest.ts";
import {
  calculateDaoMaximumWithdraw,
  compareEpochFractions,
  type DaoHarvestQuote,
} from "./dao-harvest-math.ts";
import type {
  UnsignedDeadlineTransaction as UnsignedTransaction,
  UnsignedCellOutput,
} from "./deadline-creation.ts";
import type { CellDepIdentity, ScriptIdentity } from "./job-inspection.ts";
import { deriveJobId } from "./job-identity.ts";
import {
  ABSOLUTE_EPOCH_TRIGGER_KIND,
  decodeAbsoluteEpochSince,
  decodeRelativeEpochSince,
  deriveAbsoluteEpochTriggerHash,
} from "./triggers.ts";

type Hex = `0x${string}`;

export const DAO_HARVEST_SETUP_INTENT_DOMAIN = "ckb-automata/dao-harvest-setup-intent/v1" as const;

export type DaoHarvestBuilderErrorCode =
  | "WRONG_NETWORK"
  | "STALE_OUTPOINT"
  | "INVALID_CELL"
  | "INVALID_HEADER"
  | "INSUFFICIENT_CAPACITY"
  | "EXPIRED_QUOTE"
  | "UNSAFE_PAYOUT"
  | "PRINCIPAL_DEDUCTION";

export class DaoHarvestBuilderError extends Error {
  override readonly name = "DaoHarvestBuilderError";
  readonly code: DaoHarvestBuilderErrorCode;

  constructor(code: DaoHarvestBuilderErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DaoHarvestContractDeployment {
  readonly script: Omit<ScriptIdentity, "args">;
  readonly cellDep: CellDepIdentity;
}

export interface DaoHarvestDeployment {
  readonly network: "ckb_testnet";
  readonly genesisHash: Hash32;
  readonly manifestSha256: string;
  readonly secp256k1Blake160: { readonly cellDep: CellDepIdentity };
  readonly jobLock: DaoHarvestContractDeployment;
  readonly policy: DaoHarvestContractDeployment;
  readonly vaultLock: DaoHarvestContractDeployment;
  readonly daoType: DaoHarvestContractDeployment;
}

export interface DaoHarvestSetupInput {
  readonly deployment: DaoHarvestDeployment;
  readonly expectedGenesisHash: Hash32;
  readonly ownerLockHash: Hash32;
  readonly payoutLockHash: Hash32;
  readonly principal: IntegerInput;
  readonly vaultOccupiedCapacity: IntegerInput;
  readonly jobOccupiedCapacity: IntegerInput;
  readonly prepareExecutorLockHashes: readonly Hash32[];
  readonly executorReward: IntegerInput;
  readonly minCompensation: IntegerInput;
  readonly prepareBufferEpochs: IntegerInput;
  readonly confirmationMarginEpochs: IntegerInput;
  readonly totalCycles: IntegerInput;
  readonly endEpochSince: IntegerInput;
  readonly firstPrepareSince: IntegerInput;
  readonly creatorNonce: IntegerInput;
  readonly quote: DaoHarvestQuote;
  readonly currentBlock: IntegerInput;
}

export interface DaoHarvestSigningEntry {
  readonly role: "owner" | "executor";
  readonly inputIndexes: readonly number[];
  readonly lockHash: Hash32;
}

export interface DaoHarvestSetupBuild {
  readonly transaction: UnsignedTransaction;
  readonly jobId: Hash32;
  readonly payload: Hex;
  readonly payloadHash: Hash32;
  readonly policyScriptHash: Hash32;
  readonly vaultLockHash: Hash32;
  readonly jobData: Hex;
  readonly signingEntries: readonly DaoHarvestSigningEntry[];
  readonly intent: Readonly<Record<string, string | number>>;
}

export interface DaoHarvestActionInput {
  readonly deployment: DaoHarvestDeployment;
  readonly expectedGenesisHash: Hash32;
  readonly resolver: LiveCellResolver;
  readonly vaultOutPoint: OutPoint;
  readonly jobOutPoint: OutPoint;
  readonly authorityOutPoint: OutPoint;
  readonly authorityLock: ScriptIdentity;
  readonly authorityLockHash: Hash32;
  readonly authorityOccupiedCapacity: IntegerInput;
  readonly networkFee: IntegerInput;
  readonly payload: Hex;
  readonly prepareExecutorLockHashes: readonly Hash32[];
}

export interface DaoHarvestPrepareInput extends DaoHarvestActionInput {
  readonly depositHeaderHash: Hash32;
  readonly depositBlockNumber: IntegerInput;
  readonly claimSince: IntegerInput;
}

export interface DaoHarvestRollInput extends DaoHarvestActionInput {
  readonly depositHeaderHash: Hash32;
  readonly prepareHeaderHash: Hash32;
  readonly depositAccumulatedRate: IntegerInput;
  readonly withdrawingAccumulatedRate: IntegerInput;
  readonly vaultOccupiedCapacity: IntegerInput;
  readonly payoutOccupiedCapacity: IntegerInput;
  readonly nextPrepareSince?: IntegerInput;
  readonly payoutLock: ScriptIdentity;
  readonly ownerRefundLock: ScriptIdentity;
}

export interface DaoHarvestTransitionBuild {
  readonly transaction: UnsignedTransaction;
  readonly signingEntries: readonly DaoHarvestSigningEntry[];
  readonly intent: Readonly<Record<string, string | number | boolean>>;
  readonly policyScriptHash: Hash32;
  readonly payloadHash: Hash32;
}

export interface DaoHarvestOwnerBuildInput {
  readonly deployment: DaoHarvestDeployment;
  readonly expectedGenesisHash: Hash32;
  readonly resolver: LiveCellResolver;
  readonly jobOutPoint: OutPoint;
  readonly ownerOutPoint: OutPoint;
  readonly ownerLock: ScriptIdentity;
  readonly ownerLockHash: Hash32;
  readonly payload: Hex;
}

export interface DaoHarvestOwnerExitInput extends DaoHarvestOwnerBuildInput {
  readonly vaultOutPoint: OutPoint;
  readonly depositHeaderHash: Hash32;
  readonly depositBlockNumber: IntegerInput;
}

export interface DaoHarvestMatureRecoveryInput {
  readonly deployment: DaoHarvestDeployment;
  readonly expectedGenesisHash: Hash32;
  readonly resolver: LiveCellResolver;
  readonly vaultOutPoint: OutPoint;
  readonly ownerOutPoint: OutPoint;
  readonly ownerLock: ScriptIdentity;
  readonly ownerLockHash: Hash32;
  readonly depositHeaderHash: Hash32;
  readonly prepareHeaderHash: Hash32;
  readonly depositAccumulatedRate: IntegerInput;
  readonly withdrawingAccumulatedRate: IntegerInput;
  readonly vaultOccupiedCapacity: IntegerInput;
  readonly claimSince: IntegerInput;
  readonly currentEpochSince: IntegerInput;
}

export interface DaoHarvestMatureRecoveryBuild {
  readonly transaction: UnsignedTransaction;
  readonly signingEntries: readonly DaoHarvestSigningEntry[];
  readonly intent: Readonly<Record<string, string | number | boolean>>;
  readonly vaultLockHash: Hash32;
}

function deploymentScript(contract: DaoHarvestContractDeployment, args: Hex): ScriptIdentity {
  return Object.freeze({ ...contract.script, args });
}

function domainHash(domain: string, body: Uint8Array): Uint8Array {
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, body.length, true);
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(domain));
  hasher.update(Uint8Array.of(0));
  hasher.update(size);
  hasher.update(body);
  return hasher.digest("binary") as Uint8Array;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concatenate(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function assertNetwork(deployment: DaoHarvestDeployment, expected: Hash32): void {
  if (deployment.network !== "ckb_testnet" || deployment.genesisHash !== parseHash32(expected)) {
    throw new DaoHarvestBuilderError(
      "WRONG_NETWORK",
      "DAO harvest is enabled only for the selected CKB testnet deployment",
    );
  }
}

function assertQuote(
  input: DaoHarvestSetupInput,
  principal: Shannons,
  reward: Shannons,
  actions: bigint,
): void {
  if (BigInt(input.currentBlock) > input.quote.validUntilBlock) {
    throw new DaoHarvestBuilderError("EXPIRED_QUOTE", "DAO harvest review quote has expired");
  }
  if (
    input.quote.principal !== principal ||
    input.quote.executorReward !== reward ||
    input.quote.actionBudget !== reward * actions
  ) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "DAO harvest quote no longer matches the setup terms",
    );
  }
}

function proof(executors: readonly Uint8Array[]): Uint8Array {
  return concatenate(Uint8Array.of(executors.length), ...executors);
}

function vaultArgs(jobId: Hash32, owner: Hash32, jobLock: Hash32, policy: Hash32): Hex {
  return bytesToHex(
    concatenate(
      hash32ToBytes(jobId),
      hash32ToBytes(owner),
      hash32ToBytes(jobLock),
      hash32ToBytes(policy),
    ),
  ) as Hex;
}

function normalizedIntentBytes(intent: Readonly<Record<string, string | number>>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(intent));
}

function requireAbsoluteEpoch(value: IntegerInput, name: string): bigint {
  const since = BigInt(value);
  try {
    decodeAbsoluteEpochSince(since);
  } catch {
    throw new RangeError(`${name} must be a canonical absolute epoch since`);
  }
  return since;
}

function requireRelativeEpoch(value: IntegerInput, name: string): bigint {
  const since = BigInt(value);
  try {
    decodeRelativeEpochSince(since);
  } catch {
    throw new RangeError(`${name} must be a canonical relative epoch since`);
  }
  return since;
}

export function buildDaoHarvestSetup(input: DaoHarvestSetupInput): DaoHarvestSetupBuild {
  assertNetwork(input.deployment, input.expectedGenesisHash);
  const owner = parseHash32(input.ownerLockHash);
  const payout = parseHash32(input.payoutLockHash);
  if (owner === payout) {
    throw new DaoHarvestBuilderError(
      "UNSAFE_PAYOUT",
      "compensation address must differ from the owner refund address",
    );
  }
  const principal = parseShannons(input.principal);
  const vaultOccupied = parseShannons(input.vaultOccupiedCapacity);
  const jobOccupied = parseShannons(input.jobOccupiedCapacity);
  if (principal < vaultOccupied) {
    throw new DaoHarvestBuilderError(
      "INSUFFICIENT_CAPACITY",
      "original amount is below the vault occupied capacity",
    );
  }
  const reward = parseShannons(input.executorReward);
  const minCompensation = parseShannons(input.minCompensation);
  const cycles = parseRunCount(input.totalCycles);
  if (cycles === 0n || cycles > 0x7fff_ffffn)
    throw new RangeError("totalCycles is outside the supported finite range");
  const actions = cycles * 2n;
  assertQuote(input, principal, reward, actions);
  const buffer = requireRelativeEpoch(input.prepareBufferEpochs, "prepareBufferEpochs");
  const margin = requireRelativeEpoch(input.confirmationMarginEpochs, "confirmationMarginEpochs");
  if (
    compareEpochFractions(decodeRelativeEpochSince(buffer), decodeRelativeEpochSince(margin)) <= 0
  ) {
    throw new RangeError("prepare buffer must exceed the confirmation margin");
  }
  const firstPrepare = requireAbsoluteEpoch(input.firstPrepareSince, "firstPrepareSince");
  const endSince = BigInt(input.endEpochSince);
  if (endSince !== 0n) {
    requireAbsoluteEpoch(endSince, "endEpochSince");
    if (endSince <= firstPrepare)
      throw new RangeError("end epoch must follow the first preparation window");
  }
  const nonce = parseSequence(input.creatorNonce);
  const policyScript = deploymentScript(input.deployment.policy, "0x");
  const policyScriptHash = parseHash32(scriptToHash(policyScript));
  const jobLock = deploymentScript(input.deployment.jobLock, "0x");
  const jobLockHash = parseHash32(scriptToHash(jobLock));
  const daoType = deploymentScript(input.deployment.daoType, "0x");
  const daoTypeHash = parseHash32(scriptToHash(daoType));
  const executors = normalizePrepareExecutorSet(
    input.prepareExecutorLockHashes.map((hash) => hash32ToBytes(parseHash32(hash))),
  );
  const executorSetHash = hash32FromBytes(derivePrepareExecutorSetHash(executors));
  const baseIntent = Object.freeze({
    version: 1,
    genesisHash: input.deployment.genesisHash,
    deploymentManifestSha256: input.deployment.manifestSha256,
    ownerLockHash: owner,
    payoutLockHash: payout,
    principal: principal.toString(),
    executorSetHash,
    executorReward: reward.toString(),
    minCompensation: minCompensation.toString(),
    prepareBufferEpochs: buffer.toString(),
    confirmationMarginEpochs: margin.toString(),
    totalCycles: Number(cycles),
    endEpochSince: endSince.toString(),
    firstPrepareSince: firstPrepare.toString(),
    creatorNonce: nonce.toString(),
    policyScriptHash,
    jobLockHash,
    daoTypeHash,
  });
  const intentHash = domainHash(DAO_HARVEST_SETUP_INTENT_DOMAIN, normalizedIntentBytes(baseIntent));
  const jobId = hash32FromBytes(
    deriveJobId({
      genesisHash: hash32ToBytes(input.deployment.genesisHash),
      protocolVersion: 1,
      creationCommitment: intentHash,
      anchor: { kind: "output_index", outputIndex: 1n },
      creatorNonce: nonce,
      policyScriptHash: hash32ToBytes(policyScriptHash),
    }),
  );
  const vaultLock = deploymentScript(
    input.deployment.vaultLock,
    vaultArgs(jobId, owner, jobLockHash, policyScriptHash),
  );
  const vaultLockHash = parseHash32(scriptToHash(vaultLock));
  const payloadBytes = DaoHarvestPayloadV1.pack({
    version: 1,
    owner_lock_hash: [...hash32ToBytes(owner)],
    payout_lock_hash: [...hash32ToBytes(payout)],
    vault_lock_hash: [...hash32ToBytes(vaultLockHash)],
    dao_type_hash: [...hash32ToBytes(daoTypeHash)],
    principal_capacity: principal.toString(),
    prepare_executor_set_hash: [...hash32ToBytes(executorSetHash)],
    executor_reward: reward.toString(),
    min_compensation: minCompensation.toString(),
    prepare_buffer_epochs: buffer.toString(),
    confirmation_margin_epochs: margin.toString(),
    total_cycles: Number(cycles),
    end_epoch_since: endSince.toString(),
  });
  const payload = bytesToHex(payloadBytes) as Hex;
  const payloadHash = hash32FromBytes(
    deriveDaoHarvestPayloadHash(hash32ToBytes(policyScriptHash), payloadBytes),
  );
  const jobCapacity = parseShannons(jobOccupied + reward * actions);
  const triggerHash = hash32FromBytes(deriveAbsoluteEpochTriggerHash(firstPrepare));
  const jobDataBytes = JobDataV1.pack({
    version: 1,
    flags: 0,
    job_id: [...hash32ToBytes(jobId)],
    sequence: "0",
    state: 0,
    trigger_kind: ABSOLUTE_EPOCH_TRIGGER_KIND,
    trigger_params_hash: [...hash32ToBytes(triggerHash)],
    policy_script_hash: [...hash32ToBytes(policyScriptHash)],
    payload_hash: [...hash32ToBytes(payloadHash)],
    reward: reward.toString(),
    remaining_budget: (reward * actions).toString(),
    not_before: firstPrepare.toString(),
    not_after: endSince.toString(),
    remaining_runs: Number(actions),
    cancel_lock_hash: [...hash32ToBytes(owner)],
  });
  const envelope = bytesToHex(concatenate(payloadBytes, proof(executors))) as Hex;
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([
      input.deployment.secp256k1Blake160.cellDep,
      input.deployment.jobLock.cellDep,
      input.deployment.policy.cellDep,
      input.deployment.vaultLock.cellDep,
      input.deployment.daoType.cellDep,
    ]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([]),
    outputs: Object.freeze([
      Object.freeze({ capacity: toRpcHex(principal), lock: vaultLock, type: daoType }),
      Object.freeze({ capacity: toRpcHex(jobCapacity), lock: jobLock, type: policyScript }),
    ]),
    outputsData: Object.freeze(["0x0000000000000000" as Hex, bytesToHex(jobDataBytes) as Hex]),
    witnesses: Object.freeze([
      serializeWitnessArgs({ lock: "", inputType: "", outputType: envelope }) as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    jobId,
    payload,
    payloadHash,
    policyScriptHash,
    vaultLockHash,
    jobData: bytesToHex(jobDataBytes) as Hex,
    signingEntries: Object.freeze<DaoHarvestSigningEntry[]>([
      { role: "owner", inputIndexes: Object.freeze([]), lockHash: owner },
    ]),
    intent: baseIntent,
  });
}

function sameScript(left: ScriptIdentity | null, right: ScriptIdentity): boolean {
  return left !== null && scriptToHash(left) === scriptToHash(right);
}

async function resolveRequired(
  resolver: LiveCellResolver,
  outPoint: OutPoint,
  label: string,
): Promise<ResolvedLiveCell> {
  const canonical = parseOutPoint(outPoint);
  const cell = await resolver.resolve(canonical);
  if (
    !cell ||
    cell.outPoint.txHash !== canonical.txHash ||
    cell.outPoint.index !== canonical.index
  ) {
    throw new DaoHarvestBuilderError("STALE_OUTPOINT", `${label} outpoint is no longer live`);
  }
  return cell;
}

function parsePayload(value: Hex): ReturnType<typeof DaoHarvestPayloadV1.unpack> {
  try {
    return DaoHarvestPayloadV1.unpack(hexToBytes(value));
  } catch {
    throw new DaoHarvestBuilderError("INVALID_CELL", "DAO harvest payload is malformed");
  }
}

function executionWitness(
  rewardIndex: number,
  executor: Hash32,
  controlled: readonly number[],
): Hex {
  return bytesToHex(
    concatenate(
      Uint8Array.of(0),
      u32(rewardIndex),
      hash32ToBytes(executor),
      Uint8Array.of(controlled.length),
      ...controlled.map(u32),
    ),
  ) as Hex;
}

function vaultWitness(operation: 0 | 1, jobInputIndex = 1): Hex {
  return bytesToHex(concatenate(Uint8Array.of(0, operation), u32(jobInputIndex))) as Hex;
}

function successorJob(
  data: Uint8Array | Hex,
  nextSince: bigint,
): { readonly bytes: Uint8Array; readonly remainingRuns: bigint } {
  const decoded = JobDataV1.unpack(typeof data === "string" ? hexToBytes(data) : data);
  const remaining = BigInt(decoded.remaining_runs.toString());
  const reward = BigInt(decoded.reward.toString());
  const budget = BigInt(decoded.remaining_budget.toString());
  if (remaining <= 1n || budget < reward) {
    throw new DaoHarvestBuilderError("INVALID_CELL", "job has no funded successor action");
  }
  const triggerHash = deriveAbsoluteEpochTriggerHash(nextSince);
  return Object.freeze({
    remainingRuns: remaining - 1n,
    bytes: JobDataV1.pack({
      ...decoded,
      sequence: (BigInt(decoded.sequence.toString()) + 1n).toString(),
      trigger_params_hash: [...triggerHash],
      remaining_budget: (budget - reward).toString(),
      not_before: nextSince.toString(),
      remaining_runs: Number(remaining - 1n),
    }),
  });
}

function cellInput(outPoint: OutPoint, since = 0n) {
  return Object.freeze({
    since: `0x${since.toString(16)}` as Hex,
    previousOutput: Object.freeze({ txHash: outPoint.txHash, index: toRpcHex(outPoint.index) }),
  });
}

function authorityChange(
  cell: ResolvedLiveCell,
  lock: ScriptIdentity,
  feeValue: IntegerInput,
  occupiedValue: IntegerInput,
): UnsignedCellOutput | null {
  const capacity = parseShannons(cell.output.capacity);
  const fee = parseShannons(feeValue);
  if (capacity < fee)
    throw new DaoHarvestBuilderError(
      "INSUFFICIENT_CAPACITY",
      "executor fee input cannot cover the network fee",
    );
  const change = capacity - fee;
  if (change === 0n) return null;
  if (change < parseShannons(occupiedValue)) {
    throw new DaoHarvestBuilderError(
      "INSUFFICIENT_CAPACITY",
      "executor change would be below occupied capacity",
    );
  }
  return Object.freeze({ capacity: toRpcHex(parseShannons(change)), lock, type: null });
}

function validateLiveState(
  deployment: DaoHarvestDeployment,
  payloadHex: Hex,
  vault: ResolvedLiveCell,
  job: ResolvedLiveCell,
): {
  payload: ReturnType<typeof DaoHarvestPayloadV1.unpack>;
  job: ReturnType<typeof JobDataV1.unpack>;
  policyHash: Hash32;
  payloadHash: Hash32;
} {
  const payload = parsePayload(payloadHex);
  let jobData: ReturnType<typeof JobDataV1.unpack>;
  try {
    jobData = JobDataV1.unpack(typeof job.data === "string" ? hexToBytes(job.data) : job.data);
  } catch {
    throw new DaoHarvestBuilderError("INVALID_CELL", "live Job Cell data is malformed");
  }
  const policy = deploymentScript(deployment.policy, "0x");
  const policyHash = parseHash32(scriptToHash(policy));
  const payloadHash = hash32FromBytes(
    deriveDaoHarvestPayloadHash(hash32ToBytes(policyHash), hexToBytes(payloadHex)),
  );
  const vaultTypeHash = vault.output.type ? scriptToHash(vault.output.type) : null;
  if (
    !sameScript(job.output.type, policy) ||
    bytesToHex(Uint8Array.from(jobData.policy_script_hash)) !== policyHash ||
    bytesToHex(Uint8Array.from(jobData.payload_hash)) !== payloadHash ||
    scriptToHash(vault.output.lock) !== bytesToHex(Uint8Array.from(payload.vault_lock_hash)) ||
    vaultTypeHash !== bytesToHex(Uint8Array.from(payload.dao_type_hash)) ||
    BigInt(vault.output.capacity) !== BigInt(payload.principal_capacity.toString())
  ) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "live cells do not match the committed DAO harvest policy",
    );
  }
  return { payload, job: jobData, policyHash, payloadHash };
}

function baseDeps(deployment: DaoHarvestDeployment): readonly CellDepValue[] {
  return [
    deployment.secp256k1Blake160.cellDep,
    deployment.jobLock.cellDep,
    deployment.policy.cellDep,
    deployment.vaultLock.cellDep,
    deployment.daoType.cellDep,
  ];
}

export async function buildDaoHarvestPrepare(
  inputValue: DaoHarvestPrepareInput,
): Promise<DaoHarvestTransitionBuild> {
  assertNetwork(inputValue.deployment, inputValue.expectedGenesisHash);
  const [vault, job, authority] = await Promise.all([
    resolveRequired(inputValue.resolver, inputValue.vaultOutPoint, "vault"),
    resolveRequired(inputValue.resolver, inputValue.jobOutPoint, "job"),
    resolveRequired(inputValue.resolver, inputValue.authorityOutPoint, "executor"),
  ]);
  const state = validateLiveState(inputValue.deployment, inputValue.payload, vault, job);
  if (
    (typeof vault.data === "string" ? hexToBytes(vault.data) : vault.data).some(
      (byte) => byte !== 0,
    )
  ) {
    throw new DaoHarvestBuilderError("INVALID_CELL", "prepare requires a deposited DAO vault cell");
  }
  if (BigInt(state.job.sequence.toString()) % 2n !== 0n) {
    throw new DaoHarvestBuilderError("INVALID_CELL", "job sequence is not ready for preparation");
  }
  const executorHash = parseHash32(inputValue.authorityLockHash);
  if (
    scriptToHash(authority.output.lock) !== executorHash ||
    scriptToHash(inputValue.authorityLock) !== executorHash
  ) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "executor identity cell does not match the selected lock",
    );
  }
  const claimSince = requireAbsoluteEpoch(inputValue.claimSince, "claimSince");
  const successor = successorJob(job.data, claimSince);
  const reward = parseShannons(state.job.reward.toString());
  const jobCapacity = parseShannons(job.output.capacity);
  if (jobCapacity < reward)
    throw new DaoHarvestBuilderError(
      "PRINCIPAL_DEDUCTION",
      "executor reward is not funded by the Job Cell",
    );
  const successorOutput = Object.freeze({
    capacity: toRpcHex(parseShannons(jobCapacity - reward)),
    lock: job.output.lock,
    type: job.output.type,
  });
  const change = authorityChange(
    authority,
    inputValue.authorityLock,
    inputValue.networkFee,
    inputValue.authorityOccupiedCapacity,
  );
  const outputs: UnsignedCellOutput[] = [
    Object.freeze({
      capacity: toRpcHex(parseShannons(vault.output.capacity)),
      lock: vault.output.lock,
      type: vault.output.type,
    }),
    Object.freeze({ capacity: toRpcHex(reward), lock: inputValue.authorityLock, type: null }),
    successorOutput,
  ];
  const outputsData: Hex[] = [
    bytesToHex(uint64ToLittleEndian(parseShannons(inputValue.depositBlockNumber))) as Hex,
    "0x",
    bytesToHex(successor.bytes) as Hex,
  ];
  if (change) {
    outputs.push(change);
    outputsData.push("0x");
  }
  const approvedExecutors = normalizePrepareExecutorSet(
    inputValue.prepareExecutorLockHashes.map((hash) => hash32ToBytes(parseHash32(hash))),
  );
  const committedExecutorSet = bytesToHex(Uint8Array.from(state.payload.prepare_executor_set_hash));
  if (hash32FromBytes(derivePrepareExecutorSetHash(approvedExecutors)) !== committedExecutorSet) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "approved executor set differs from the committed set",
    );
  }
  if (!approvedExecutors.some((identity) => bytesToHex(identity) === executorHash)) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "executor is not in the approved preparation set",
    );
  }
  const envelope = concatenate(hexToBytes(inputValue.payload), proof(approvedExecutors));
  const controlled = [1, 2];
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze(baseDeps(inputValue.deployment) as CellDepIdentity[]),
    headerDeps: Object.freeze([parseHash32(inputValue.depositHeaderHash)]),
    inputs: Object.freeze([
      cellInput(inputValue.vaultOutPoint),
      cellInput(inputValue.jobOutPoint, BigInt(state.job.not_before.toString())),
      cellInput(inputValue.authorityOutPoint),
    ]),
    outputs: Object.freeze(outputs),
    outputsData: Object.freeze(outputsData),
    witnesses: Object.freeze([
      serializeWitnessArgs({
        lock: vaultWitness(DAO_HARVEST_OPERATIONS.PREPARE),
        inputType: "",
        outputType: "",
      }) as Hex,
      serializeWitnessArgs({
        lock: "",
        inputType: executionWitness(1, executorHash, controlled),
        outputType: bytesToHex(envelope),
      }) as Hex,
      "0x" as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    signingEntries: Object.freeze<DaoHarvestSigningEntry[]>([
      { role: "executor", inputIndexes: Object.freeze([2]), lockHash: executorHash },
    ]),
    intent: Object.freeze({
      kind: "prepare",
      principal: state.payload.principal_capacity.toString(),
      claimSince: claimSince.toString(),
      paysExecutorReward: true,
    }),
    policyScriptHash: state.policyHash,
    payloadHash: state.payloadHash,
  });
}

export async function buildDaoHarvestRoll(
  inputValue: DaoHarvestRollInput,
): Promise<DaoHarvestTransitionBuild> {
  assertNetwork(inputValue.deployment, inputValue.expectedGenesisHash);
  const [vault, job, authority] = await Promise.all([
    resolveRequired(inputValue.resolver, inputValue.vaultOutPoint, "vault"),
    resolveRequired(inputValue.resolver, inputValue.jobOutPoint, "job"),
    resolveRequired(inputValue.resolver, inputValue.authorityOutPoint, "executor"),
  ]);
  const state = validateLiveState(inputValue.deployment, inputValue.payload, vault, job);
  const vaultData = typeof vault.data === "string" ? hexToBytes(vault.data) : vault.data;
  if (
    vaultData.length !== 8 ||
    vaultData.every((byte) => byte === 0) ||
    BigInt(state.job.sequence.toString()) % 2n !== 1n
  ) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "roll requires a withdrawing vault and claim-ready sequence",
    );
  }
  const payoutHash = bytesToHex(Uint8Array.from(state.payload.payout_lock_hash));
  if (scriptToHash(inputValue.payoutLock) !== payoutHash) {
    throw new DaoHarvestBuilderError(
      "UNSAFE_PAYOUT",
      "payout lock differs from the approved address",
    );
  }
  const executorHash = parseHash32(inputValue.authorityLockHash);
  if (
    scriptToHash(authority.output.lock) !== executorHash ||
    scriptToHash(inputValue.authorityLock) !== executorHash
  ) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "executor identity cell does not match the selected lock",
    );
  }
  const principal = parseShannons(state.payload.principal_capacity.toString());
  const maximum = calculateDaoMaximumWithdraw({
    principal,
    occupiedCapacity: inputValue.vaultOccupiedCapacity,
    depositAccumulatedRate: inputValue.depositAccumulatedRate,
    withdrawingAccumulatedRate: inputValue.withdrawingAccumulatedRate,
  });
  const compensation = parseShannons(maximum - principal);
  if (compensation < BigInt(state.payload.min_compensation.toString())) {
    throw new DaoHarvestBuilderError(
      "INVALID_HEADER",
      "confirmed DAO compensation is below the approved minimum",
    );
  }
  if (compensation < parseShannons(inputValue.payoutOccupiedCapacity)) {
    throw new DaoHarvestBuilderError(
      "INSUFFICIENT_CAPACITY",
      "compensation is too small to create the approved payout cell",
    );
  }
  const ownerHash = bytesToHex(Uint8Array.from(state.payload.owner_lock_hash));
  if (scriptToHash(inputValue.ownerRefundLock) !== ownerHash) {
    throw new DaoHarvestBuilderError(
      "UNSAFE_PAYOUT",
      "terminal refund lock differs from the approved owner",
    );
  }
  const reward = parseShannons(state.job.reward.toString());
  const jobCapacity = parseShannons(job.output.capacity);
  const remainingRuns = BigInt(state.job.remaining_runs.toString());
  const change = authorityChange(
    authority,
    inputValue.authorityLock,
    inputValue.networkFee,
    inputValue.authorityOccupiedCapacity,
  );
  const outputs: UnsignedCellOutput[] = [
    Object.freeze({
      capacity: toRpcHex(principal),
      lock: vault.output.lock,
      type: vault.output.type,
    }),
    Object.freeze({ capacity: toRpcHex(reward), lock: inputValue.authorityLock, type: null }),
    Object.freeze({ capacity: toRpcHex(compensation), lock: inputValue.payoutLock, type: null }),
  ];
  const outputsData: Hex[] = ["0x0000000000000000", "0x", "0x"];
  const controlled = [1];
  if (remainingRuns > 1n) {
    if (inputValue.nextPrepareSince === undefined)
      throw new DaoHarvestBuilderError(
        "INVALID_HEADER",
        "next preparation epoch is required for recurrence",
      );
    const nextSince = requireAbsoluteEpoch(inputValue.nextPrepareSince, "nextPrepareSince");
    const successor = successorJob(job.data, nextSince);
    outputs.push(
      Object.freeze({
        capacity: toRpcHex(parseShannons(jobCapacity - reward)),
        lock: job.output.lock,
        type: job.output.type,
      }),
    );
    outputsData.push(bytesToHex(successor.bytes) as Hex);
    controlled.push(3);
  } else {
    outputs.push(
      Object.freeze({
        capacity: toRpcHex(parseShannons(jobCapacity - reward)),
        lock: inputValue.ownerRefundLock,
        type: null,
      }),
    );
    outputsData.push("0x");
    controlled.push(3);
  }
  if (change) {
    outputs.push(change);
    outputsData.push("0x");
  }
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze(baseDeps(inputValue.deployment) as CellDepIdentity[]),
    headerDeps: Object.freeze([
      parseHash32(inputValue.depositHeaderHash),
      parseHash32(inputValue.prepareHeaderHash),
    ]),
    inputs: Object.freeze([
      cellInput(inputValue.vaultOutPoint, BigInt(state.job.not_before.toString())),
      cellInput(inputValue.jobOutPoint, BigInt(state.job.not_before.toString())),
      cellInput(inputValue.authorityOutPoint),
    ]),
    outputs: Object.freeze(outputs),
    outputsData: Object.freeze(outputsData),
    witnesses: Object.freeze([
      serializeWitnessArgs({
        lock: vaultWitness(DAO_HARVEST_OPERATIONS.ROLL),
        inputType: "0x0000000000000000",
        outputType: "",
      }) as Hex,
      serializeWitnessArgs({
        lock: "",
        inputType: executionWitness(1, executorHash, controlled),
        outputType: inputValue.payload,
      }) as Hex,
      "0x" as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    signingEntries: Object.freeze<DaoHarvestSigningEntry[]>([
      { role: "executor", inputIndexes: Object.freeze([2]), lockHash: executorHash },
    ]),
    intent: Object.freeze({
      kind: "claim_and_redeposit",
      principal: principal.toString(),
      compensation: compensation.toString(),
      paysExecutorReward: true,
      createsSuccessor: remainingRuns > 1n,
    }),
    policyScriptHash: state.policyHash,
    payloadHash: state.payloadHash,
  });
}

async function buildOwnerJobRefund(
  inputValue: DaoHarvestOwnerBuildInput,
  kind: "stop_recurrence" | "owner_exit" | "recovery",
  operation: "0x01" | "0x02",
): Promise<DaoHarvestTransitionBuild> {
  assertNetwork(inputValue.deployment, inputValue.expectedGenesisHash);
  const [job, ownerCell] = await Promise.all([
    resolveRequired(inputValue.resolver, inputValue.jobOutPoint, "job"),
    resolveRequired(inputValue.resolver, inputValue.ownerOutPoint, "owner"),
  ]);
  const ownerHash = parseHash32(inputValue.ownerLockHash);
  if (
    scriptToHash(inputValue.ownerLock) !== ownerHash ||
    scriptToHash(ownerCell.output.lock) !== ownerHash
  ) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "owner authorization input does not match the committed owner",
    );
  }
  const payload = parsePayload(inputValue.payload);
  if (bytesToHex(Uint8Array.from(payload.owner_lock_hash)) !== ownerHash) {
    throw new DaoHarvestBuilderError("INVALID_CELL", "owner differs from the DAO harvest policy");
  }
  const policy = deploymentScript(inputValue.deployment.policy, "0x");
  const policyHash = parseHash32(scriptToHash(policy));
  const payloadHash = hash32FromBytes(
    deriveDaoHarvestPayloadHash(hash32ToBytes(policyHash), hexToBytes(inputValue.payload)),
  );
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze(baseDeps(inputValue.deployment) as CellDepIdentity[]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([cellInput(inputValue.jobOutPoint), cellInput(inputValue.ownerOutPoint)]),
    outputs: Object.freeze([
      Object.freeze({
        capacity: toRpcHex(parseShannons(job.output.capacity)),
        lock: inputValue.ownerLock,
        type: null,
      }),
      Object.freeze({
        capacity: toRpcHex(parseShannons(ownerCell.output.capacity)),
        lock: inputValue.ownerLock,
        type: null,
      }),
    ]),
    outputsData: Object.freeze(["0x" as Hex, "0x" as Hex]),
    witnesses: Object.freeze([
      serializeWitnessArgs({
        lock: "",
        inputType: operation,
        outputType: inputValue.payload,
      }) as Hex,
      "0x" as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    signingEntries: Object.freeze<DaoHarvestSigningEntry[]>([
      { role: "owner", inputIndexes: Object.freeze([1]), lockHash: ownerHash },
    ]),
    intent: Object.freeze({ kind, paysExecutorReward: false, preservesVault: true }),
    policyScriptHash: policyHash,
    payloadHash,
  });
}

export function buildDaoHarvestStopRecurrence(
  input: DaoHarvestOwnerBuildInput,
): Promise<DaoHarvestTransitionBuild> {
  return buildOwnerJobRefund(input, "stop_recurrence", "0x01");
}

export async function buildDaoHarvestOwnerExit(
  inputValue: DaoHarvestOwnerExitInput,
): Promise<DaoHarvestTransitionBuild> {
  assertNetwork(inputValue.deployment, inputValue.expectedGenesisHash);
  const [vault, job, ownerCell] = await Promise.all([
    resolveRequired(inputValue.resolver, inputValue.vaultOutPoint, "vault"),
    resolveRequired(inputValue.resolver, inputValue.jobOutPoint, "job"),
    resolveRequired(inputValue.resolver, inputValue.ownerOutPoint, "owner"),
  ]);
  const state = validateLiveState(inputValue.deployment, inputValue.payload, vault, job);
  const ownerHash = parseHash32(inputValue.ownerLockHash);
  if (
    bytesToHex(Uint8Array.from(state.payload.owner_lock_hash)) !== ownerHash ||
    scriptToHash(inputValue.ownerLock) !== ownerHash ||
    scriptToHash(ownerCell.output.lock) !== ownerHash
  ) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "owner exit input does not match the committed owner",
    );
  }
  const vaultData = typeof vault.data === "string" ? hexToBytes(vault.data) : vault.data;
  if (vaultData.length !== 8 || vaultData.some((byte) => byte !== 0)) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "this owner exit builder starts from a deposited vault; a withdrawing vault requires mature recovery",
    );
  }
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze(baseDeps(inputValue.deployment) as CellDepIdentity[]),
    headerDeps: Object.freeze([parseHash32(inputValue.depositHeaderHash)]),
    inputs: Object.freeze([
      cellInput(inputValue.vaultOutPoint),
      cellInput(inputValue.jobOutPoint),
      cellInput(inputValue.ownerOutPoint),
    ]),
    outputs: Object.freeze([
      Object.freeze({
        capacity: toRpcHex(parseShannons(vault.output.capacity)),
        lock: vault.output.lock,
        type: vault.output.type,
      }),
      Object.freeze({
        capacity: toRpcHex(parseShannons(job.output.capacity)),
        lock: inputValue.ownerLock,
        type: null,
      }),
      Object.freeze({
        capacity: toRpcHex(parseShannons(ownerCell.output.capacity)),
        lock: inputValue.ownerLock,
        type: null,
      }),
    ]),
    outputsData: Object.freeze([
      bytesToHex(uint64ToLittleEndian(parseShannons(inputValue.depositBlockNumber))) as Hex,
      "0x" as Hex,
      "0x" as Hex,
    ]),
    witnesses: Object.freeze([
      serializeWitnessArgs({
        lock: bytesToHex(Uint8Array.of(1, DAO_HARVEST_OPERATIONS.OWNER_EXIT)),
        inputType: "",
        outputType: "",
      }) as Hex,
      serializeWitnessArgs({ lock: "", inputType: "0x01", outputType: inputValue.payload }) as Hex,
      "0x" as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    signingEntries: Object.freeze<DaoHarvestSigningEntry[]>([
      { role: "owner", inputIndexes: Object.freeze([2]), lockHash: ownerHash },
    ]),
    intent: Object.freeze({
      kind: "owner_exit",
      paysExecutorReward: false,
      preservesPrincipal: true,
      requiresMaturityBeforeClaim: true,
    }),
    policyScriptHash: state.policyHash,
    payloadHash: state.payloadHash,
  });
}

export function buildDaoHarvestRecovery(
  input: DaoHarvestOwnerBuildInput,
): Promise<DaoHarvestTransitionBuild> {
  return buildOwnerJobRefund(input, "recovery", "0x02");
}

export async function buildDaoHarvestMatureRecovery(
  inputValue: DaoHarvestMatureRecoveryInput,
): Promise<DaoHarvestMatureRecoveryBuild> {
  assertNetwork(inputValue.deployment, inputValue.expectedGenesisHash);
  const claimEpoch = decodeAbsoluteEpochSince(inputValue.claimSince);
  const currentEpoch = decodeAbsoluteEpochSince(inputValue.currentEpochSince);
  if (compareEpochFractions(currentEpoch, claimEpoch) < 0) {
    throw new DaoHarvestBuilderError(
      "INVALID_HEADER",
      "mature recovery cannot be built before the DAO claim epoch",
    );
  }
  const [vault, ownerCell] = await Promise.all([
    resolveRequired(inputValue.resolver, inputValue.vaultOutPoint, "vault"),
    resolveRequired(inputValue.resolver, inputValue.ownerOutPoint, "owner"),
  ]);
  const ownerHash = parseHash32(inputValue.ownerLockHash);
  const vaultLockArgs = hexToBytes(vault.output.lock.args);
  const committedOwner =
    vaultLockArgs.length === 128 ? bytesToHex(vaultLockArgs.slice(32, 64)) : null;
  const expectedVaultScript = inputValue.deployment.vaultLock.script;
  const expectedDaoType = deploymentScript(inputValue.deployment.daoType, "0x");
  if (
    vault.output.lock.codeHash !== expectedVaultScript.codeHash ||
    vault.output.lock.hashType !== expectedVaultScript.hashType ||
    committedOwner !== ownerHash ||
    !sameScript(vault.output.type, expectedDaoType) ||
    scriptToHash(inputValue.ownerLock) !== ownerHash ||
    scriptToHash(ownerCell.output.lock) !== ownerHash
  ) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "mature recovery input does not match the committed owner",
    );
  }
  const vaultData = typeof vault.data === "string" ? hexToBytes(vault.data) : vault.data;
  if (vaultData.length !== 8 || vaultData.every((byte) => byte === 0)) {
    throw new DaoHarvestBuilderError(
      "INVALID_CELL",
      "mature recovery requires a withdrawing DAO vault",
    );
  }
  const maximum = calculateDaoMaximumWithdraw({
    principal: vault.output.capacity,
    occupiedCapacity: inputValue.vaultOccupiedCapacity,
    depositAccumulatedRate: inputValue.depositAccumulatedRate,
    withdrawingAccumulatedRate: inputValue.withdrawingAccumulatedRate,
  });
  const transaction: UnsignedTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([
      inputValue.deployment.secp256k1Blake160.cellDep,
      inputValue.deployment.vaultLock.cellDep,
      inputValue.deployment.daoType.cellDep,
    ]),
    headerDeps: Object.freeze([
      parseHash32(inputValue.depositHeaderHash),
      parseHash32(inputValue.prepareHeaderHash),
    ]),
    inputs: Object.freeze([
      cellInput(inputValue.vaultOutPoint, BigInt(inputValue.claimSince)),
      cellInput(inputValue.ownerOutPoint),
    ]),
    outputs: Object.freeze([
      Object.freeze({
        capacity: toRpcHex(maximum),
        lock: inputValue.ownerLock,
        type: null,
      }),
      Object.freeze({
        capacity: toRpcHex(parseShannons(ownerCell.output.capacity)),
        lock: inputValue.ownerLock,
        type: null,
      }),
    ]),
    outputsData: Object.freeze(["0x" as Hex, "0x" as Hex]),
    witnesses: Object.freeze([
      serializeWitnessArgs({
        lock: bytesToHex(Uint8Array.of(1, DAO_HARVEST_OPERATIONS.OWNER_RECOVER)),
        inputType: "",
        outputType: "",
      }) as Hex,
      "0x" as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    signingEntries: Object.freeze<DaoHarvestSigningEntry[]>([
      { role: "owner", inputIndexes: Object.freeze([1]), lockHash: ownerHash },
    ]),
    intent: Object.freeze({
      kind: "mature_recovery",
      paysExecutorReward: false,
      returnsMaximumWithdraw: maximum.toString(),
      terminatesAutomation: true,
    }),
    vaultLockHash: parseHash32(scriptToHash(vault.output.lock)),
  });
}
