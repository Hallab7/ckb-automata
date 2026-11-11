import {
  DaoHarvestEnvelopeV3,
  DaoHarvestPayloadV3,
  DaoHarvestPrepareCreditV3,
  DaoHarvestProgressV3,
  DaoHarvestWitnessV3,
} from "@ckb-automata/molecule";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  hash32FromBytes,
  parseHash32,
  parseShannons,
  sameCellDepValue,
  type CellDepValue,
  type Hash32,
  type IntegerInput,
  type Shannons,
} from "./chain-values.ts";
import type {
  UnsignedCellInput,
  UnsignedCellOutput,
  UnsignedDeadlineTransaction,
} from "./deadline-creation.ts";
import type { CellDepIdentity } from "./job-inspection.ts";
import {
  DAO_HARVEST_V3_OPERATIONS,
  DAO_HARVEST_V3_VERSION,
  absentDaoHarvestV3Indices,
  assertDaoHarvestV3WitnessLayout,
  deriveDaoHarvestV3IntentHash,
  deriveDaoHarvestV3PayloadHash,
  deriveDaoHarvestV3PrepareCreditHash,
  deriveDaoHarvestV3ProgressHash,
  type DaoHarvestV3Operation,
  type DaoHarvestV3WitnessIndices,
} from "./dao-harvest-v3.ts";

type Hex = `0x${string}`;

export interface DaoHarvestV3DeploymentIdentity {
  readonly network: "ckb_testnet";
  readonly genesisHash: Hash32;
  readonly manifestSha256: string;
  readonly contracts: Readonly<
    Record<
      "jobLock" | "policy" | "vaultLock" | "compensationLock",
      {
        readonly codeHash: Hash32;
        readonly cellDep: CellDepIdentity;
      }
    >
  >;
  readonly secp256k1Blake160: { readonly cellDep: CellDepIdentity };
  readonly nervosDao: { readonly codeHash: Hash32; readonly cellDep: CellDepIdentity };
}

export interface DaoHarvestV3ChainContext {
  readonly rpcGenesisHash: Hash32;
  readonly deployment: DaoHarvestV3DeploymentIdentity;
  readonly canonicalHeaderHashes: readonly Hash32[];
  readonly liveOutPoints: readonly UnsignedCellInput["previousOutput"][];
  readonly signerLockHash: Hash32;
}

export interface DaoHarvestV3ReviewedInput {
  readonly input: UnsignedCellInput;
  readonly capacity: IntegerInput;
  readonly lockHash: Hash32;
}

export interface DaoHarvestV3ReviewedOutput {
  readonly output: UnsignedCellOutput;
  readonly data: Hex;
}

export interface DaoHarvestV3NamedInputs {
  readonly job?: DaoHarvestV3ReviewedInput;
  readonly vault?: DaoHarvestV3ReviewedInput;
  readonly compensation?: DaoHarvestV3ReviewedInput;
  readonly identity: DaoHarvestV3ReviewedInput;
  readonly prepareAccumulator?: DaoHarvestV3ReviewedInput;
  readonly claimAccumulator?: DaoHarvestV3ReviewedInput;
  readonly additional?: readonly DaoHarvestV3ReviewedInput[];
}

export interface DaoHarvestV3NamedOutputs {
  readonly job?: DaoHarvestV3ReviewedOutput;
  readonly vault?: DaoHarvestV3ReviewedOutput;
  readonly compensation?: DaoHarvestV3ReviewedOutput;
  readonly prepareAccumulator?: DaoHarvestV3ReviewedOutput;
  readonly claimAccumulator?: DaoHarvestV3ReviewedOutput;
  readonly additional?: readonly DaoHarvestV3ReviewedOutput[];
}

export interface DaoHarvestV3BuildInput {
  readonly context: DaoHarvestV3ChainContext;
  readonly policyScriptHash: Hash32;
  readonly ownerLockHash: Hash32;
  readonly payload: Uint8Array;
  readonly progress: Uint8Array;
  readonly prepareCredit?: Uint8Array;
  readonly operatorProof?: Uint8Array;
  readonly successorPayload?: Uint8Array;
  readonly inputs: DaoHarvestV3NamedInputs;
  readonly outputs: DaoHarvestV3NamedOutputs;
  readonly headerDeps?: readonly Hash32[];
  readonly additionalWitnesses?: readonly Hex[];
  readonly maximumNetworkFee: IntegerInput;
  readonly allowedFundingLockHashes: readonly Hash32[];
}

export interface DaoHarvestV3Build {
  readonly operation: DaoHarvestV3Operation;
  readonly transaction: UnsignedDeadlineTransaction;
  readonly intentHash: Hash32;
  readonly value: {
    readonly totalInput: Shannons;
    readonly totalOutput: Shannons;
    readonly maximumNetworkFee: Shannons;
  };
  readonly completion: {
    readonly requiredInputCount: number;
    readonly requiredOutputCount: number;
    readonly requiredInputCapacity: Shannons;
    readonly maximumFee: Shannons;
    readonly allowedFundingLockHashes: readonly Hash32[];
    readonly protectedSameIndex?: number;
  };
}

export interface ResolvedDaoHarvestV3FundingInput {
  readonly outPoint: UnsignedCellInput["previousOutput"];
  readonly capacity: IntegerInput;
  readonly lockHash: Hash32;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const bytes = (value?: Uint8Array) =>
  value === undefined ? new Uint8Array() : Uint8Array.from(value);
const committedHash = (value: readonly number[]) => hash32FromBytes(Uint8Array.from(value));
const outPointKey = (value: UnsignedCellInput["previousOutput"]) =>
  `${parseHash32(value.txHash)}:${BigInt(value.index)}`;
const outputCapacity = (outputs: readonly UnsignedCellOutput[]) =>
  parseShannons(outputs.reduce((sum, output) => sum + BigInt(output.capacity), 0n));

function assertContext(input: DaoHarvestV3BuildInput, ownerOperation: boolean): void {
  const { context } = input;
  if (context.deployment.network !== "ckb_testnet")
    throw new Error("DAO Harvest V3 is testnet-only");
  if (parseHash32(context.rpcGenesisHash) !== parseHash32(context.deployment.genesisHash))
    throw new Error("RPC genesis does not match the V3 deployment manifest");
  if (!/^[0-9a-f]{64}$/.test(context.deployment.manifestSha256))
    throw new Error("V3 deployment manifest identity is invalid");
  if (ownerOperation && parseHash32(context.signerLockHash) !== parseHash32(input.ownerLockHash))
    throw new Error("connected signer is not the committed owner");
  const live = new Set(context.liveOutPoints.map(outPointKey));
  const reviewed = flattenInputs(input.inputs);
  for (const item of reviewed)
    if (!live.has(outPointKey(item.input.previousOutput)))
      throw new Error(
        `reviewed input ${outPointKey(item.input.previousOutput)} is stale or not live`,
      );
  const canonical = new Set(context.canonicalHeaderHashes.map(parseHash32));
  for (const header of input.headerDeps ?? [])
    if (!canonical.has(parseHash32(header)))
      throw new Error("reviewed header is not canonical in the build context");
}

function flattenInputs(value: DaoHarvestV3NamedInputs): DaoHarvestV3ReviewedInput[] {
  const candidates = [
    value.job,
    value.vault,
    value.compensation,
    value.identity,
    value.prepareAccumulator,
    value.claimAccumulator,
    ...(value.additional ?? []),
  ].filter((item): item is DaoHarvestV3ReviewedInput => item !== undefined);
  return candidates.filter((item, index) => candidates.indexOf(item) === index);
}
function flattenOutputs(
  value: DaoHarvestV3NamedOutputs,
  operation?: DaoHarvestV3Operation,
): DaoHarvestV3ReviewedOutput[] {
  if (operation === DAO_HARVEST_V3_OPERATIONS.OWNER_EXIT)
    return [value.additional?.[0], value.vault, ...(value.additional?.slice(1) ?? [])].filter(
      (item): item is DaoHarvestV3ReviewedOutput => item !== undefined,
    );
  return [
    value.job,
    value.vault,
    value.compensation,
    value.prepareAccumulator,
    value.claimAccumulator,
    ...(value.additional ?? []),
  ].filter((item): item is DaoHarvestV3ReviewedOutput => item !== undefined);
}

function indexOfInput(
  all: readonly DaoHarvestV3ReviewedInput[],
  target?: DaoHarvestV3ReviewedInput,
) {
  return target === undefined ? 0xffff_ffff : all.indexOf(target);
}
function indexOfOutput(
  all: readonly DaoHarvestV3ReviewedOutput[],
  target?: DaoHarvestV3ReviewedOutput,
) {
  return target === undefined ? 0xffff_ffff : all.indexOf(target);
}

function deriveIndices(
  input: DaoHarvestV3BuildInput,
  operation: DaoHarvestV3Operation,
): DaoHarvestV3WitnessIndices {
  const inputs = flattenInputs(input.inputs);
  const outputs = flattenOutputs(input.outputs, operation);
  return Object.freeze({
    ...absentDaoHarvestV3Indices(),
    jobInputIndex: indexOfInput(inputs, input.inputs.job),
    vaultInputIndex: indexOfInput(inputs, input.inputs.vault),
    compensationInputIndex: indexOfInput(inputs, input.inputs.compensation),
    identityInputIndex: indexOfInput(inputs, input.inputs.identity),
    prepareAccumulatorInputIndex: indexOfInput(inputs, input.inputs.prepareAccumulator),
    claimAccumulatorInputIndex: indexOfInput(inputs, input.inputs.claimAccumulator),
    jobOutputIndex: indexOfOutput(outputs, input.outputs.job),
    vaultOutputIndex: indexOfOutput(outputs, input.outputs.vault),
    compensationOutputIndex: indexOfOutput(outputs, input.outputs.compensation),
    prepareAccumulatorOutputIndex: indexOfOutput(outputs, input.outputs.prepareAccumulator),
    claimAccumulatorOutputIndex: indexOfOutput(outputs, input.outputs.claimAccumulator),
  });
}

function build(
  operation: DaoHarvestV3Operation,
  input: DaoHarvestV3BuildInput,
  ownerOperation: boolean,
): DaoHarvestV3Build {
  assertContext(input, ownerOperation);
  const payload = DaoHarvestPayloadV3.unpack(input.payload);
  const terminalClose = operation === DAO_HARVEST_V3_OPERATIONS.CLOSE;
  const progress = terminalClose ? undefined : DaoHarvestProgressV3.unpack(input.progress);
  if (Number(payload.version) !== 3 || (!terminalClose && Number(progress!.version) !== 3))
    throw new Error("V3 builder received another payload version");
  if (terminalClose && input.progress.length !== 0)
    throw new Error("V3 terminal close requires an empty progress envelope");
  if (committedHash(payload.owner_lock_hash) !== parseHash32(input.ownerLockHash))
    throw new Error("owner lock does not match the V3 payload");
  if (
    committedHash(payload.vault_lock_code_hash) !==
      input.context.deployment.contracts.vaultLock.codeHash ||
    committedHash(payload.compensation_lock_code_hash) !==
      input.context.deployment.contracts.compensationLock.codeHash ||
    committedHash(payload.dao_type_hash) !==
      parseHash32(
        scriptToHash({
          codeHash: input.context.deployment.nervosDao.codeHash,
          hashType: "type",
          args: "0x",
        }),
      )
  )
    throw new Error("V3 payload contract identity does not match the deployment manifest");
  const credit = bytes(input.prepareCredit);
  if (credit.length > 0) DaoHarvestPrepareCreditV3.unpack(credit);
  const proof = bytes(input.operatorProof);
  const successor = bytes(input.successorPayload);
  const creditRequired = [1, 2, 3, 4, 5, 10].includes(operation);
  const proofRequired = [0, 2, 8].includes(operation);
  if (creditRequired === (credit.length === 0))
    throw new Error("operation has an invalid V3 prepare credit envelope");
  if (proofRequired === (proof.length === 0))
    throw new Error("operation has an invalid V3 operator proof envelope");
  if ((operation === DAO_HARVEST_V3_OPERATIONS.ROTATE) === (successor.length === 0))
    throw new Error("operation has an invalid V3 successor payload envelope");
  if (
    [3, 4, 5, 10].includes(operation) &&
    committedHash(progress!.prepare_credit_hash) !==
      hash32FromBytes(deriveDaoHarvestV3PrepareCreditHash(credit))
  )
    throw new Error("prepare credit does not match the live V3 progress");
  const indices = deriveIndices(input, operation);
  assertDaoHarvestV3WitnessLayout(operation, indices);
  if (
    operation === DAO_HARVEST_V3_OPERATIONS.OWNER_EXIT &&
    indices.vaultInputIndex !== indices.vaultOutputIndex
  )
    throw new Error("owner exit requires the DAO vault output at the same transaction index");
  const policyHash = parseHash32(input.policyScriptHash);
  const payloadHash = deriveDaoHarvestV3PayloadHash(hexToBytes(policyHash), input.payload);
  const progressHash = terminalClose
    ? new Uint8Array(32)
    : deriveDaoHarvestV3ProgressHash(input.progress);
  const creditHash =
    credit.length === 0 ? new Uint8Array(32) : deriveDaoHarvestV3PrepareCreditHash(credit);
  const witness = DaoHarvestWitnessV3.pack({
    version: DAO_HARVEST_V3_VERSION,
    operation,
    flags: 0,
    job_input_index: indices.jobInputIndex,
    vault_input_index: indices.vaultInputIndex,
    compensation_input_index: indices.compensationInputIndex,
    identity_input_index: indices.identityInputIndex,
    prepare_accumulator_input_index: indices.prepareAccumulatorInputIndex,
    claim_accumulator_input_index: indices.claimAccumulatorInputIndex,
    job_output_index: indices.jobOutputIndex,
    vault_output_index: indices.vaultOutputIndex,
    compensation_output_index: indices.compensationOutputIndex,
    prepare_accumulator_output_index: indices.prepareAccumulatorOutputIndex,
    claim_accumulator_output_index: indices.claimAccumulatorOutputIndex,
    payload_hash: [...payloadHash],
    progress_hash: [...progressHash],
    prepare_credit_hash: [...creditHash],
  });
  const envelope = DaoHarvestEnvelopeV3.pack({
    payload: [...input.payload],
    progress: [...input.progress],
    prepare_credit: [...credit],
    operator_proof: [...proof],
    successor_payload: [...successor],
  });
  const reviewedInputs = flattenInputs(input.inputs);
  const reviewedOutputs = flattenOutputs(input.outputs, operation);
  const additionalWitnesses = input.additionalWitnesses ?? [];
  if (
    additionalWitnesses.length !== 0 &&
    additionalWitnesses.length !== Math.max(0, reviewedInputs.length - 1)
  ) {
    throw new Error("V3 additional witnesses must match every reviewed input after the Job input");
  }
  const transaction = Object.freeze<UnsignedDeadlineTransaction>({
    version: "0x0",
    cellDeps: Object.freeze([
      input.context.deployment.secp256k1Blake160.cellDep,
      input.context.deployment.contracts.jobLock.cellDep,
      input.context.deployment.contracts.policy.cellDep,
      input.context.deployment.contracts.vaultLock.cellDep,
      input.context.deployment.contracts.compensationLock.cellDep,
      input.context.deployment.nervosDao.cellDep,
    ]),
    headerDeps: Object.freeze((input.headerDeps ?? []).map(parseHash32)),
    inputs: Object.freeze(reviewedInputs.map((item) => item.input)),
    outputs: Object.freeze(reviewedOutputs.map((item) => item.output)),
    outputsData: Object.freeze(reviewedOutputs.map((item) => item.data)),
    witnesses: Object.freeze([
      serializeWitnessArgs({
        lock: "",
        inputType: bytesToHex(witness),
        outputType: bytesToHex(envelope),
      }) as Hex,
      ...(additionalWitnesses.length === 0
        ? Array.from({ length: Math.max(0, reviewedInputs.length - 1) }, () => "0x" as Hex)
        : additionalWitnesses),
    ]),
  });
  if (
    new Set(transaction.inputs.map((item) => outPointKey(item.previousOutput))).size !==
    transaction.inputs.length
  )
    throw new Error("reviewed inputs contain a duplicate outpoint");
  const totalInput = parseShannons(
    reviewedInputs.reduce((sum, item) => sum + parseShannons(item.capacity), 0n),
  );
  const totalOutput = outputCapacity(transaction.outputs);
  if (totalOutput > totalInput) throw new Error("reviewed outputs exceed reviewed inputs");
  const maximumNetworkFee = parseShannons(input.maximumNetworkFee);
  if (totalInput - totalOutput > maximumNetworkFee)
    throw new Error("reviewed transaction fee exceeds its maximum");
  const normalized = {
    operation,
    manifest: input.context.deployment.manifestSha256,
    policyHash,
    payloadHash: hash32FromBytes(payloadHash),
    progressHash: hash32FromBytes(progressHash),
    creditHash: hash32FromBytes(creditHash),
    transaction,
  };
  return Object.freeze({
    operation,
    transaction,
    intentHash: hash32FromBytes(
      deriveDaoHarvestV3IntentHash(new TextEncoder().encode(stable(normalized))),
    ),
    value: Object.freeze({ totalInput, totalOutput, maximumNetworkFee }),
    completion: Object.freeze({
      requiredInputCount: transaction.inputs.length,
      requiredOutputCount: transaction.outputs.length,
      requiredInputCapacity: totalInput,
      maximumFee: maximumNetworkFee,
      allowedFundingLockHashes: Object.freeze(input.allowedFundingLockHashes.map(parseHash32)),
      ...(operation === DAO_HARVEST_V3_OPERATIONS.OWNER_EXIT
        ? { protectedSameIndex: indices.vaultInputIndex }
        : {}),
    }),
  });
}

export const buildDaoHarvestV3Setup = (input: DaoHarvestV3BuildInput) => build(0, input, false);
export const buildDaoHarvestV3PreferredPrepare = (input: DaoHarvestV3BuildInput) =>
  build(1, input, false);
export const buildDaoHarvestV3FallbackPrepare = (input: DaoHarvestV3BuildInput) =>
  build(2, input, false);
export const buildDaoHarvestV3PreferredClaim = (input: DaoHarvestV3BuildInput) =>
  build(3, input, false);
export const buildDaoHarvestV3FallbackClaim = (input: DaoHarvestV3BuildInput) =>
  build(4, input, false);
export const buildDaoHarvestV3OwnerCompletion = (input: DaoHarvestV3BuildInput) =>
  build(5, input, true);
export const buildDaoHarvestV3Sweep = (input: DaoHarvestV3BuildInput) => build(6, input, true);
export const buildDaoHarvestV3Close = (input: DaoHarvestV3BuildInput) => build(7, input, true);
export const buildDaoHarvestV3Rotation = (input: DaoHarvestV3BuildInput) => build(8, input, true);
export const buildDaoHarvestV3OwnerExit = (input: DaoHarvestV3BuildInput) => build(9, input, true);
export const buildDaoHarvestV3OwnerRecovery = (input: DaoHarvestV3BuildInput) =>
  build(10, input, true);

function sameInput(left: UnsignedCellInput, right: UnsignedCellInput) {
  return stable(left) === stable(right);
}
function hasRequiredDeps(required: readonly CellDepValue[], completed: readonly CellDepValue[]) {
  const unmatched = [...completed];
  return required.every((dep) => {
    const index = unmatched.findIndex((candidate) => sameCellDepValue(dep, candidate));
    if (index < 0) return false;
    unmatched.splice(index, 1);
    return true;
  });
}

function witnessPolicyFields(value: Hex): { readonly inputType: Hex; readonly outputType: Hex } {
  const witness = hexToBytes(value);
  if (witness.length < 16) throw new Error("wallet returned an invalid reviewed witness");
  const view = new DataView(witness.buffer, witness.byteOffset, witness.byteLength);
  const total = view.getUint32(0, true);
  const first = view.getUint32(4, true);
  const second = view.getUint32(8, true);
  const third = view.getUint32(12, true);
  if (total !== witness.length || first !== 16 || second < first || third < second || third > total)
    throw new Error("wallet returned an invalid reviewed witness");
  const field = (start: number, end: number): Hex => {
    if (start === end) return "0x";
    if (end - start < 4 || view.getUint32(start, true) !== end - start - 4)
      throw new Error("wallet returned an invalid reviewed witness");
    return bytesToHex(witness.slice(start + 4, end)) as Hex;
  };
  return Object.freeze({ inputType: field(second, third), outputType: field(third, total) });
}

export function verifyCompletedDaoHarvestV3Transaction(
  buildResult: DaoHarvestV3Build,
  completed: UnsignedDeadlineTransaction,
  fundingInputs: readonly ResolvedDaoHarvestV3FundingInput[],
): { readonly fee: Shannons; readonly addedInputCapacity: Shannons } {
  const reviewed = buildResult.transaction;
  if (completed.version !== reviewed.version)
    throw new Error("wallet changed the reviewed version");
  if (stable(completed.headerDeps) !== stable(reviewed.headerDeps))
    throw new Error("wallet changed reviewed header dependencies");
  if (!hasRequiredDeps(reviewed.cellDeps, completed.cellDeps))
    throw new Error("wallet changed reviewed cell dependencies");
  if (
    completed.inputs.length < reviewed.inputs.length ||
    completed.outputs.length < reviewed.outputs.length
  )
    throw new Error("wallet removed a reviewed input or output");
  if (!hasRequiredDeps(reviewed.cellDeps, completed.cellDeps))
    throw new Error("wallet changed reviewed cell dependencies");
  if (stable(completed.headerDeps) !== stable(reviewed.headerDeps))
    throw new Error("wallet changed reviewed header dependencies");
  reviewed.inputs.forEach((item, index) => {
    if (!sameInput(item, completed.inputs[index]!))
      throw new Error(`wallet reordered reviewed input ${index}`);
  });
  reviewed.outputs.forEach((item, index) => {
    if (
      stable(item) !== stable(completed.outputs[index]) ||
      reviewed.outputsData[index] !== completed.outputsData[index]
    )
      throw new Error(`wallet changed reviewed output ${index}`);
  });
  if (
    completed.witnesses[0] === undefined ||
    stable(witnessPolicyFields(completed.witnesses[0])) !==
      stable(witnessPolicyFields(reviewed.witnesses[0]!))
  )
    throw new Error("wallet changed the reviewed policy witness");
  const protectedIndex = buildResult.completion.protectedSameIndex;
  if (
    protectedIndex !== undefined &&
    (stable(completed.outputs[protectedIndex]) !== stable(reviewed.outputs[protectedIndex]) ||
      completed.outputsData[protectedIndex] !== reviewed.outputsData[protectedIndex])
  )
    throw new Error("wallet changed the DAO same-index owner exit output");
  if (completed.outputs.length !== completed.outputsData.length)
    throw new Error("wallet returned mismatched outputs and data");
  const allowed = new Set(buildResult.completion.allowedFundingLockHashes);
  const resolved = new Map<string, ResolvedDaoHarvestV3FundingInput>();
  for (const item of fundingInputs) {
    const key = outPointKey(item.outPoint);
    if (resolved.has(key))
      throw new Error("funding input resolutions contain a duplicate outpoint");
    resolved.set(key, item);
  }
  const consumed = new Set(reviewed.inputs.map((item) => outPointKey(item.previousOutput)));
  let added = 0n;
  for (const item of completed.inputs.slice(reviewed.inputs.length)) {
    const key = outPointKey(item.previousOutput);
    if (consumed.has(key)) throw new Error("wallet duplicated an input outpoint");
    consumed.add(key);
    const cell = resolved.get(key);
    if (!cell || !allowed.has(parseHash32(cell.lockHash)))
      throw new Error("wallet added an input outside reviewed funding locks");
    added += parseShannons(cell.capacity);
  }
  for (let index = reviewed.outputs.length; index < completed.outputs.length; index += 1) {
    const output = completed.outputs[index]!;
    if (
      output.type !== null ||
      completed.outputsData[index] !== "0x" ||
      !allowed.has(parseHash32(scriptToHash(output.lock)))
    )
      throw new Error("wallet added a non-plain or unreviewed change output");
  }
  const totalInput = buildResult.completion.requiredInputCapacity + added;
  const totalOutput = outputCapacity(completed.outputs);
  if (totalOutput > totalInput) throw new Error("wallet outputs exceed resolved inputs");
  const fee = parseShannons(totalInput - totalOutput);
  if (fee > buildResult.completion.maximumFee)
    throw new Error("wallet fee exceeds reviewed maximum");
  return Object.freeze({ fee, addedInputCapacity: parseShannons(added) });
}
