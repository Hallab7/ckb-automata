import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";
import {
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  addEpochs,
  buildDaoHarvestV3Close,
  buildDaoHarvestV3ClaimTransition,
  buildDaoHarvestV3Rotation,
  buildDaoHarvestV3Sweep,
  buildDaoHarvestV3Setup,
  buildDaoHarvestV3OwnerExit,
  buildDaoHarvestV3OwnerRecovery,
  calculateDaoMaximumWithdraw,
  compareEpochFractions,
  createEpoch,
  decodeDaoHarvestV3CompensationLockArgs,
  decodeAbsoluteEpochSince,
  decodeRelativeEpochSince,
  deriveDaoHarvestV3FallbackOperatorSetHash,
  deriveDaoHarvestV3PayloadHash,
  deriveDaoHarvestV3ProgressHash,
  deriveDaoHarvestV3VaultTermsHash,
  deriveJobId,
  encodeDaoHarvestV3CompensationLockArgs,
  encodeDaoHarvestV3FallbackOperatorProof,
  encodeAbsoluteEpochSince,
  encodeDaoHarvestV3VaultLockArgs,
  encodeRelativeEpochSince,
  hash32FromBytes,
  parseHash32,
  parseEpoch,
  parseOutPoint,
  parseShannons,
  parseSequence,
  scriptIdentityHash,
  selectDaoPrepareWindow,
  type DaoHarvestV3DeploymentIdentity,
  type DaoHarvestV3ReviewedInput,
  type DaoHarvestV3TransitionCell,
  type ScriptIdentity,
} from "@ckb-automata/core";
import { packClientEpoch } from "@ckb-automata/ccc";
import {
  DaoHarvestPayloadV3,
  DaoHarvestPrepareCreditV3,
  DaoHarvestProgressV3,
  JobDataV1,
} from "@ckb-automata/molecule";
import type { CkbReadClient } from "./ckb-client.ts";
import type { AutomataDatabase } from "./database/client.ts";
import { daoHarvestV3Jobs } from "./database/schema.ts";
import { and, eq } from "drizzle-orm";
import type { DaoHarvestV3BuildOperation, DaoHarvestV3MutationAdapter } from "./dao-harvest-v3.ts";

type Hex = `0x${string}`;
const CKB = 100_000_000n;
const JOB_CAPACITY = 400n * CKB;
const COMPENSATION_SEED = 201n * CKB;
const PREPARE_SERVICE_FEE = 2n * CKB;
const CLAIM_SERVICE_FEE = 3n * CKB;
const MAXIMUM_NETWORK_FEE = 1n * CKB;
const PREPARE_BUFFER_EPOCHS = 4n;
const CONFIRMATION_MARGIN_EPOCHS = 1n;
const MINIMUM_PRINCIPAL = 242n * CKB;
const MAXIMUM_CYCLES = 12;
const object = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BadRequestException(`${name} must be an object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string) => {
  if (typeof value !== "string") throw new BadRequestException(`${name} must be a string`);
  return value;
};
const decimal = (value: unknown, name: string) => {
  const item = text(value, name);
  if (!/^(0|[1-9][0-9]*)$/.test(item))
    throw new BadRequestException(`${name} must be a canonical amount`);
  return BigInt(item);
};
function outPoint(value: unknown, name: string) {
  const item = object(value, name);
  return parseOutPoint({
    txHash: text(item["txHash"], `${name}.txHash`),
    index: text(item["index"], `${name}.index`),
  });
}
function lock(value: unknown, name: string): ScriptIdentity {
  const item = object(value, name);
  const hashType = text(item["hashType"], `${name}.hashType`);
  const args = text(item["args"], `${name}.args`);
  if (
    !(["data", "data1", "data2", "type"] as string[]).includes(hashType) ||
    !/^0x(?:[0-9a-f]{2})*$/.test(args)
  )
    throw new BadRequestException(`${name} is not a canonical CKB script`);
  return Object.freeze({
    codeHash: parseHash32(text(item["codeHash"], `${name}.codeHash`)),
    hashType: hashType as ScriptIdentity["hashType"],
    args: args as Hex,
  });
}
function chainText(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return value.toString();
  }
  throw new BadRequestException(`${name} is unavailable`);
}
function chainLock(value: {
  readonly codeHash: unknown;
  readonly hashType: unknown;
  readonly args: unknown;
}): ScriptIdentity {
  return lock(
    {
      codeHash: chainText(value.codeHash, "chain script code hash"),
      hashType: chainText(value.hashType, "chain script hash type"),
      args: chainText(value.args, "chain script args"),
    },
    "chain script",
  );
}
function accumulatedRate(value: unknown): bigint {
  const dao = String(value);
  if (!/^0x[0-9a-f]{64}$/.test(dao)) throw new Error("canonical DAO header data is unavailable");
  return BigInt(`0x${dao.slice(18, 34).match(/../g)!.toReversed().join("")}`);
}
const txPoint = (value: ReturnType<typeof parseOutPoint>) => ({
  txHash: value.txHash,
  index: `0x${value.index.toString(16)}` as Hex,
});
function reviewed(
  cell: NonNullable<Awaited<ReturnType<CkbReadClient["getCellLive"]>>>,
  point: ReturnType<typeof parseOutPoint>,
  since = 0n,
  effectiveCapacity?: bigint,
): DaoHarvestV3ReviewedInput {
  return Object.freeze({
    input: Object.freeze({
      since: `0x${since.toString(16)}` as Hex,
      previousOutput: txPoint(point),
    }),
    capacity: effectiveCapacity ?? parseShannons(cell.cellOutput.capacity.toString()),
    lockHash: parseHash32(scriptToHash(chainLock(cell.cellOutput.lock))),
  });
}
const output = (
  capacity: bigint,
  lockValue: ScriptIdentity,
  typeValue: ScriptIdentity | null,
  data: Hex = "0x",
) =>
  Object.freeze({
    output: Object.freeze({
      capacity: `0x${capacity.toString(16)}` as Hex,
      lock: lockValue,
      type: typeValue,
    }),
    data,
  });
function u64(value: bigint): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, true);
  return result;
}
function u32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}
function u16(value: number): Uint8Array {
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value, true);
  return result;
}

function transitionCell(
  cell: NonNullable<Awaited<ReturnType<CkbReadClient["getCellLive"]>>>,
  point: ReturnType<typeof parseOutPoint>,
): DaoHarvestV3TransitionCell {
  return Object.freeze({
    outPoint: Object.freeze({ txHash: point.txHash, index: point.index }),
    capacity: parseShannons(cell.cellOutput.capacity.toString()),
    lock: chainLock(cell.cellOutput.lock),
    type: cell.cellOutput.type === undefined ? null : chainLock(cell.cellOutput.type),
    data: cell.outputData.toString() as Hex,
  });
}

export function daoHarvestV3PolicyScriptHash(value: {
  readonly codeHash: unknown;
  readonly hashType: unknown;
  readonly args: unknown;
}) {
  return parseHash32(scriptToHash(chainLock(value)));
}

export function daoHarvestV3SweepAmounts(compensationCapacityValue: bigint, reserveValue: bigint) {
  const compensationCapacity = parseShannons(compensationCapacityValue);
  const reserve = parseShannons(reserveValue);
  if (compensationCapacity <= reserve) {
    throw new BadRequestException("there is no earned compensation available to withdraw");
  }
  return Object.freeze({ reserve, payout: compensationCapacity - reserve });
}

export function daoHarvestV3RotationPayload(
  payload: ReturnType<typeof DaoHarvestPayloadV3.unpack>,
  preferredValue: string,
  fallbackValues: readonly string[],
) {
  const preferred = parseHash32(preferredValue);
  const fallback = fallbackValues.map((value) => hexToBytes(parseHash32(value)));
  const proof = encodeDaoHarvestV3FallbackOperatorProof(fallback);
  const successorPayload = DaoHarvestPayloadV3.pack({
    ...payload,
    preferred_prepare_operator_lock_hash: [...hexToBytes(preferred)],
    fallback_prepare_executor_set_hash: [...deriveDaoHarvestV3FallbackOperatorSetHash(fallback)],
  });
  return Object.freeze({ proof, successorPayload });
}

export function daoHarvestV3TerminalClosePolicyHash(
  payloadBytes: Uint8Array,
  payload: ReturnType<typeof DaoHarvestPayloadV3.unpack>,
  deployment: DaoHarvestV3DeploymentIdentity,
  compensationArgs: ReturnType<typeof decodeDaoHarvestV3CompensationLockArgs>,
  ownerLockHash: string,
) {
  const policyScriptHash = parseHash32(bytesToHex(compensationArgs.policyScriptHash));
  const expectedPolicyScriptHash = parseHash32(
    scriptToHash({
      codeHash: deployment.contracts.policy.codeHash,
      hashType: "data1",
      args: deployment.contracts.jobLock.codeHash as Hex,
    }),
  );
  const expectedPayloadHash = deriveDaoHarvestV3PayloadHash(
    hexToBytes(expectedPolicyScriptHash),
    payloadBytes,
  );
  if (
    compensationArgs.jobId.some((value) => value !== 0) ||
    bytesToHex(compensationArgs.ownerLockHash) !== ownerLockHash ||
    bytesToHex(compensationArgs.payoutLockHash) !==
      bytesToHex(Uint8Array.from(payload.payout_lock_hash)) ||
    policyScriptHash !== expectedPolicyScriptHash ||
    bytesToHex(compensationArgs.payloadHash) !== bytesToHex(expectedPayloadHash)
  ) {
    throw new BadRequestException("the terminal compensation binding is invalid");
  }
  return policyScriptHash;
}

export class DaoHarvestV3TransactionAdapter implements DaoHarvestV3MutationAdapter {
  readonly #chain: CkbReadClient;
  readonly #database: AutomataDatabase;
  readonly #network: string;
  readonly #deployments: readonly DaoHarvestV3DeploymentIdentity[];
  constructor(
    chain: CkbReadClient,
    database: AutomataDatabase,
    network: string,
    deployments: readonly DaoHarvestV3DeploymentIdentity[],
  ) {
    this.#chain = chain;
    this.#database = database;
    this.#network = network;
    this.#deployments = deployments;
  }
  async build(operation: DaoHarvestV3BuildOperation, bodyValue: unknown): Promise<unknown> {
    if (operation === "setup") return this.#buildSetup(bodyValue);
    if (
      !["sweep", "close", "rotate", "owner-exit", "owner-recovery", "owner-complete"].includes(
        operation,
      )
    )
      throw new ServiceUnavailableException(`DAO Harvest V3 ${operation} builder is not enabled`);
    const body = object(bodyValue, "request");
    const jobId = parseHash32(text(body["jobId"], "jobId"));
    const ownerLock = lock(body["ownerLock"], "ownerLock");
    const ownerLockHash = scriptIdentityHash(ownerLock);
    const identityPoint = outPoint(body["identityOutPoint"], "identityOutPoint");
    const fee = decimal(body["maximumNetworkFee"], "maximumNetworkFee");
    const [row] = await this.#database
      .select()
      .from(daoHarvestV3Jobs)
      .where(
        and(
          eq(daoHarvestV3Jobs.networkId, this.#network),
          eq(daoHarvestV3Jobs.jobId, jobId),
          eq(daoHarvestV3Jobs.canonical, true),
        ),
      )
      .limit(1);
    if (!row) throw new BadRequestException("DAO Harvest V3 automation was not found");
    if (row.ownerLockHash !== ownerLockHash)
      throw new BadRequestException("connected wallet is not the automation owner");
    const projection = object(row.projection, "canonical projection");
    const payloadBytes = hexToBytes(text(projection["payload"], "payload"));
    const payload = DaoHarvestPayloadV3.unpack(payloadBytes);
    const deployment = this.#deployments.find(
      (candidate) =>
        candidate.contracts.vaultLock.codeHash ===
          bytesToHex(Uint8Array.from(payload.vault_lock_code_hash)) &&
        candidate.contracts.compensationLock.codeHash ===
          bytesToHex(Uint8Array.from(payload.compensation_lock_code_hash)),
    );
    if (!deployment)
      throw new ServiceUnavailableException("the V3 contract revision is unavailable");
    if (operation === "close") {
      if (row.lifecycleState !== "completed")
        throw new BadRequestException("only a completed automation can be closed");
      const compensationPoint = outPoint(
        projection["compensationOutPoint"],
        "compensationOutPoint",
      );
      const [compensationCell, identityCell] = await Promise.all([
        this.#chain.getCellLive(compensationPoint),
        this.#chain.getCellLive(identityPoint),
      ]);
      if (!compensationCell || !identityCell)
        throw new BadRequestException(
          "the canonical automation state changed; refresh and try again",
        );
      if (
        chainText(compensationCell.cellOutput.lock.codeHash, "compensation lock code hash") !==
          deployment.contracts.compensationLock.codeHash ||
        compensationCell.cellOutput.type !== undefined ||
        compensationCell.outputData.toString() !== "0x"
      ) {
        throw new BadRequestException("the terminal compensation cell does not match the manifest");
      }
      if (
        scriptIdentityHash(chainLock(identityCell.cellOutput.lock)) !== ownerLockHash ||
        identityCell.cellOutput.type !== undefined ||
        identityCell.outputData.toString() !== "0x"
      ) {
        throw new BadRequestException("the selected owner cell is no longer available");
      }
      const payoutLock = lock(body["payoutLock"], "payoutLock");
      if (scriptIdentityHash(payoutLock) !== bytesToHex(Uint8Array.from(payload.payout_lock_hash)))
        throw new BadRequestException("payout lock does not match the committed address");
      const compensationArgs = decodeDaoHarvestV3CompensationLockArgs(
        hexToBytes(chainLock(compensationCell.cellOutput.lock).args),
      );
      const policyScriptHash = daoHarvestV3TerminalClosePolicyHash(
        payloadBytes,
        payload,
        deployment,
        compensationArgs,
        ownerLockHash,
      );
      const identityCapacity = parseShannons(identityCell.cellOutput.capacity.toString());
      if (identityCapacity <= fee)
        throw new BadRequestException("the selected wallet cell cannot cover the network fee");
      return buildDaoHarvestV3Close({
        context: {
          rpcGenesisHash: await this.#chain.getGenesisHash(),
          deployment,
          canonicalHeaderHashes: [],
          liveOutPoints: [compensationPoint, identityPoint].map(txPoint),
          signerLockHash: ownerLockHash,
        },
        policyScriptHash,
        ownerLockHash,
        payload: payloadBytes,
        progress: new Uint8Array(),
        inputs: {
          compensation: reviewed(compensationCell, compensationPoint),
          identity: reviewed(identityCell, identityPoint),
        },
        outputs: {
          additional: [
            output(
              parseShannons(compensationCell.cellOutput.capacity.toString()),
              payoutLock,
              null,
            ),
            output(identityCapacity - fee, ownerLock, null),
          ],
        },
        maximumNetworkFee: fee,
        allowedFundingLockHashes: [ownerLockHash],
      });
    }
    const jobPoint = outPoint(projection["jobOutPoint"], "jobOutPoint");
    const vaultPoint = outPoint(projection["vaultOutPoint"], "vaultOutPoint");
    const compensationPoint = outPoint(projection["compensationOutPoint"], "compensationOutPoint");
    const [jobCell, vaultCell, compensationCell, identityCell] = await Promise.all([
      this.#chain.getCellLive(jobPoint),
      this.#chain.getCellLive(vaultPoint),
      this.#chain.getCellLive(compensationPoint),
      this.#chain.getCellLive(identityPoint),
    ]);
    if (!jobCell || !vaultCell || !compensationCell || !identityCell)
      throw new BadRequestException(
        "the canonical automation state changed; refresh and try again",
      );
    const progressBytes = hexToBytes(text(projection["progress"], "progress"));
    const progress = DaoHarvestProgressV3.unpack(progressBytes);
    if (
      jobCell.cellOutput.type === undefined ||
      chainText(jobCell.cellOutput.type.codeHash, "job policy code hash") !==
        deployment.contracts.policy.codeHash ||
      chainText(jobCell.cellOutput.lock.codeHash, "job lock code hash") !==
        deployment.contracts.jobLock.codeHash ||
      chainText(vaultCell.cellOutput.lock.codeHash, "vault lock code hash") !==
        deployment.contracts.vaultLock.codeHash ||
      chainText(compensationCell.cellOutput.lock.codeHash, "compensation lock code hash") !==
        deployment.contracts.compensationLock.codeHash
    ) {
      throw new BadRequestException("the live V3 cells do not match the selected manifest");
    }
    const policyScriptHash = daoHarvestV3PolicyScriptHash(jobCell.cellOutput.type);
    const job = JobDataV1.unpack(hexToBytes(jobCell.outputData.toString()));
    const identityCapacity = parseShannons(identityCell.cellOutput.capacity.toString());
    if (
      scriptIdentityHash(chainLock(identityCell.cellOutput.lock)) !== ownerLockHash ||
      identityCell.cellOutput.type !== undefined ||
      identityCell.outputData.toString() !== "0x"
    )
      throw new BadRequestException("the selected owner cell is no longer available");
    if (identityCapacity <= fee)
      throw new BadRequestException("the selected wallet cell cannot cover the network fee");
    const vaultData = vaultCell.outputData.toString() as Hex;
    const vaultBytes = hexToBytes(vaultData);
    if (vaultBytes.length !== 8) throw new BadRequestException("the DAO vault data is invalid");
    const depositBlockNumber = new DataView(
      vaultBytes.buffer,
      vaultBytes.byteOffset,
      8,
    ).getBigUint64(0, true);
    const depositBlock = await this.#chain.getBlockByNumber(depositBlockNumber);
    if (!depositBlock)
      throw new BadRequestException("the canonical DAO deposit header is unavailable");
    const common = {
      context: {
        rpcGenesisHash: await this.#chain.getGenesisHash(),
        deployment,
        canonicalHeaderHashes: [parseHash32(depositBlock.header.hash)],
        liveOutPoints: [jobPoint, vaultPoint, compensationPoint, identityPoint].map(txPoint),
        signerLockHash: ownerLockHash,
      },
      policyScriptHash,
      ownerLockHash,
      payload: payloadBytes,
      progress: progressBytes,
      maximumNetworkFee: fee,
      allowedFundingLockHashes: [ownerLockHash],
    };
    let build;
    if (operation === "sweep") {
      const payoutLock = lock(body["payoutLock"], "payoutLock");
      if (
        scriptIdentityHash(payoutLock) !== bytesToHex(Uint8Array.from(payload.payout_lock_hash))
      ) {
        throw new BadRequestException("payout lock does not match the committed address");
      }
      const compensationCapacity = parseShannons(compensationCell.cellOutput.capacity.toString());
      const amounts = daoHarvestV3SweepAmounts(
        compensationCapacity,
        BigInt(payload.compensation_seed_capacity.toString()),
      );
      build = buildDaoHarvestV3Sweep({
        ...common,
        inputs: {
          job: reviewed(jobCell, jobPoint),
          compensation: reviewed(compensationCell, compensationPoint),
          identity: reviewed(identityCell, identityPoint),
        },
        outputs: {
          job: output(
            parseShannons(jobCell.cellOutput.capacity.toString()),
            chainLock(jobCell.cellOutput.lock),
            chainLock(jobCell.cellOutput.type),
            jobCell.outputData.toString() as Hex,
          ),
          compensation: output(amounts.reserve, chainLock(compensationCell.cellOutput.lock), null),
          additional: [
            output(amounts.payout, payoutLock, null),
            output(identityCapacity - fee, ownerLock, null),
          ],
        },
      });
    } else if (operation === "rotate") {
      if (Number(progress.state) !== 0 || row.lifecycleState !== "deposited") {
        throw new BadRequestException("operators can be updated only before withdrawal starts");
      }
      const preferred = parseHash32(
        text(body["preferredOperatorLockHash"], "preferredOperatorLockHash"),
      );
      const fallbackValue = body["fallbackOperatorLockHashes"];
      if (!Array.isArray(fallbackValue)) {
        throw new BadRequestException("fallbackOperatorLockHashes must be an array");
      }
      const fallback = fallbackValue.map((value, index) =>
        parseHash32(text(value, `fallbackOperatorLockHashes[${index}]`)),
      );
      let rotation: ReturnType<typeof daoHarvestV3RotationPayload>;
      try {
        rotation = daoHarvestV3RotationPayload(payload, preferred, fallback);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : "the operator set is invalid",
        );
      }
      const successorHash = deriveDaoHarvestV3PayloadHash(
        hexToBytes(policyScriptHash),
        rotation.successorPayload,
      );
      const successorJob = JobDataV1.pack({
        ...job,
        payload_hash: [...successorHash],
      });
      const compensationLock = chainLock(compensationCell.cellOutput.lock);
      const compensationArgs = decodeDaoHarvestV3CompensationLockArgs(
        hexToBytes(compensationLock.args),
      );
      const successorCompensationLock = Object.freeze({
        ...compensationLock,
        args: bytesToHex(
          encodeDaoHarvestV3CompensationLockArgs({
            ...compensationArgs,
            payloadHash: successorHash,
          }),
        ) as Hex,
      });
      build = buildDaoHarvestV3Rotation({
        ...common,
        operatorProof: rotation.proof,
        successorPayload: rotation.successorPayload,
        inputs: {
          job: reviewed(jobCell, jobPoint),
          compensation: reviewed(compensationCell, compensationPoint),
          identity: reviewed(identityCell, identityPoint),
        },
        outputs: {
          job: output(
            parseShannons(jobCell.cellOutput.capacity.toString()),
            chainLock(jobCell.cellOutput.lock),
            chainLock(jobCell.cellOutput.type),
            bytesToHex(successorJob) as Hex,
          ),
          compensation: output(
            parseShannons(compensationCell.cellOutput.capacity.toString()),
            successorCompensationLock,
            null,
          ),
          additional: [output(identityCapacity - fee, ownerLock, null)],
        },
      });
    } else if (operation === "owner-exit") {
      if (Number(progress.state) !== 0 || row.lifecycleState !== "deposited")
        throw new BadRequestException("only a deposited V3 position can start withdrawal");
      const principal = BigInt(payload.principal_capacity.toString());
      if (parseShannons(vaultCell.cellOutput.capacity.toString()) !== principal) {
        throw new BadRequestException("the live DAO vault no longer preserves the original amount");
      }
      const refund =
        parseShannons(jobCell.cellOutput.capacity.toString()) +
        parseShannons(compensationCell.cellOutput.capacity.toString());
      build = buildDaoHarvestV3OwnerExit({
        ...common,
        inputs: {
          job: reviewed(jobCell, jobPoint),
          vault: reviewed(vaultCell, vaultPoint),
          compensation: reviewed(compensationCell, compensationPoint),
          identity: reviewed(identityCell, identityPoint),
        },
        outputs: {
          vault: output(principal, ownerLock, chainLock(vaultCell.cellOutput.type!), vaultData),
          additional: [
            output(refund, ownerLock, null),
            output(identityCapacity - fee, ownerLock, null),
          ],
        },
        headerDeps: [parseHash32(depositBlock.header.hash)],
      });
    } else {
      if (Number(progress.state) !== 1 || row.lifecycleState !== "withdrawing")
        throw new BadRequestException("this owner action requires a withdrawing V3 position");
      const preparePoint = outPoint(
        body["prepareAccumulatorOutPoint"],
        "prepareAccumulatorOutPoint",
      );
      const prepareCell = await this.#chain.getCellLive(preparePoint);
      if (!prepareCell) throw new BadRequestException("prepare payment cell is stale");
      const source = await this.#chain.getTransactionStatus(vaultPoint.txHash);
      if (source?.blockNumber === undefined)
        throw new BadRequestException("the canonical DAO prepare header is unavailable");
      const prepareBlock = await this.#chain.getBlockByNumber(
        BigInt(source.blockNumber.toString()),
      );
      if (!prepareBlock)
        throw new BadRequestException("the canonical DAO prepare header is unavailable");
      const creditBytes = hexToBytes(text(projection["prepareCreditBytes"], "prepareCreditBytes"));
      const credit = DaoHarvestPrepareCreditV3.unpack(creditBytes);
      const expectedPreparer = bytesToHex(Uint8Array.from(credit.preparer_lock_hash));
      if (scriptIdentityHash(chainLock(prepareCell.cellOutput.lock)) !== expectedPreparer)
        throw new BadRequestException("prepare payment cell belongs to another operator");
      const principal = BigInt(payload.principal_capacity.toString());
      if (parseShannons(vaultCell.cellOutput.capacity.toString()) !== principal) {
        throw new BadRequestException("the live DAO vault no longer preserves the original amount");
      }
      const tip = await this.#chain.getTipHeader();
      if (
        compareEpochFractions(
          parseEpoch(packClientEpoch(tip.epoch)),
          decodeAbsoluteEpochSince(job.not_before.toString()),
        ) < 0
      ) {
        throw new BadRequestException("the DAO withdrawal is not mature yet");
      }
      const maximum = calculateDaoMaximumWithdraw({
        principal,
        occupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
        depositAccumulatedRate: accumulatedRate(depositBlock.header.dao),
        withdrawingAccumulatedRate: accumulatedRate(prepareBlock.header.dao),
      });
      const gross = maximum - principal;
      const prepareCap = BigInt(payload.prepare_service_fee.toString());
      const preparePayment = gross < prepareCap ? gross : prepareCap;
      const compensationCapacity = parseShannons(compensationCell.cellOutput.capacity.toString());
      const jobCapacity = parseShannons(jobCell.cellOutput.capacity.toString());
      const claimSince = BigInt(job.not_before.toString());
      if (operation === "owner-complete") {
        const remainingRuns = BigInt(job.remaining_runs.toString());
        const nextPrepareSince =
          remainingRuns > 1n
            ? encodeAbsoluteEpochSince(
                selectDaoPrepareWindow({
                  deposit: addEpochs(parseEpoch(packClientEpoch(tip.epoch)), 1n),
                  tip: addEpochs(parseEpoch(packClientEpoch(tip.epoch)), 1n),
                  bufferEpochs: decodeRelativeEpochSince(payload.prepare_buffer_epochs.toString())
                    .number,
                  confirmationMarginEpochs: decodeRelativeEpochSince(
                    payload.confirmation_margin_epochs.toString(),
                  ).number,
                }).startsAt,
              )
            : undefined;
        build = buildDaoHarvestV3ClaimTransition({
          deployment,
          policyScriptHash,
          payload: payloadBytes,
          progress: progressBytes,
          job: transitionCell(jobCell, jobPoint),
          vault: transitionCell(vaultCell, vaultPoint),
          accumulator: transitionCell(identityCell, identityPoint),
          feeCell: transitionCell(identityCell, identityPoint),
          operatorOwnerLock: ownerLock,
          transactionFee: fee,
          rpcGenesisHash: await this.#chain.getGenesisHash(),
          canonicalHeaderHashes: [
            parseHash32(depositBlock.header.hash),
            parseHash32(prepareBlock.header.hash),
          ],
          ownerLock,
          operation: "owner_complete",
          prepareCredit: creditBytes,
          compensation: transitionCell(compensationCell, compensationPoint),
          prepareAccumulator: transitionCell(prepareCell, preparePoint),
          depositHeaderHash: parseHash32(depositBlock.header.hash),
          prepareHeaderHash: parseHash32(prepareBlock.header.hash),
          depositAccumulatedRate: accumulatedRate(depositBlock.header.dao),
          prepareAccumulatedRate: accumulatedRate(prepareBlock.header.dao),
          vaultOccupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
          executionSince: claimSince,
          ...(nextPrepareSince === undefined ? {} : { nextPrepareSince }),
        });
      } else {
        const ownerPayout = maximum - preparePayment + compensationCapacity + jobCapacity;
        const context = {
          ...common.context,
          canonicalHeaderHashes: [
            parseHash32(depositBlock.header.hash),
            parseHash32(prepareBlock.header.hash),
          ],
          liveOutPoints: [...common.context.liveOutPoints, txPoint(preparePoint)],
        };
        build = buildDaoHarvestV3OwnerRecovery({
          ...common,
          context,
          prepareCredit: creditBytes,
          inputs: {
            job: reviewed(jobCell, jobPoint),
            vault: reviewed(vaultCell, vaultPoint, claimSince, maximum),
            compensation: reviewed(compensationCell, compensationPoint),
            identity: reviewed(identityCell, identityPoint),
            prepareAccumulator: reviewed(prepareCell, preparePoint),
          },
          outputs: {
            prepareAccumulator: output(
              parseShannons(prepareCell.cellOutput.capacity.toString()) + preparePayment,
              chainLock(prepareCell.cellOutput.lock),
              null,
            ),
            additional: [
              output(ownerPayout, ownerLock, null),
              output(identityCapacity - fee, ownerLock, null),
            ],
          },
          headerDeps: [
            parseHash32(depositBlock.header.hash),
            parseHash32(prepareBlock.header.hash),
          ],
          additionalWitnesses: [
            serializeWitnessArgs({
              lock: "",
              inputType: bytesToHex(new Uint8Array(8)),
              outputType: "",
            }) as Hex,
            "0x",
            "0x",
            "0x",
          ],
        });
      }
    }
    return Object.freeze({
      version: 3,
      jobId,
      operation,
      chain: Object.freeze({
        genesisHash: deployment.genesisHash,
        manifestSha256: deployment.manifestSha256,
      }),
      transaction: build.transaction,
      intentHash: build.intentHash,
      review: Object.freeze({
        protectedAmount: BigInt(payload.principal_capacity.toString()).toString(),
        maximumNetworkFee: fee.toString(),
        totalInput: build.value.totalInput.toString(),
        totalOutput: build.value.totalOutput.toString(),
      }),
      completion: Object.freeze({
        ...build.completion,
        requiredInputCapacity: build.completion.requiredInputCapacity.toString(),
        maximumFee: build.completion.maximumFee.toString(),
      }),
    });
  }

  async #buildSetup(bodyValue: unknown) {
    const body = object(bodyValue, "request");
    const setupKeys = new Set([
      "creatorNonce",
      "identityOutPoint",
      "ownerLock",
      "ownerLockHash",
      "payoutLock",
      "payoutLockHash",
      "principal",
      "totalCycles",
      "preferredOperatorLockHash",
      "fallbackOperatorLockHashes",
    ]);
    if (
      Object.keys(body).length !== setupKeys.size ||
      Object.keys(body).some((key) => !setupKeys.has(key))
    )
      throw new BadRequestException("DAO Harvest V3 setup contains unsupported fields");
    const ownerLock = lock(body["ownerLock"], "ownerLock");
    const payoutLock = lock(body["payoutLock"], "payoutLock");
    const ownerLockHash = parseHash32(text(body["ownerLockHash"], "ownerLockHash"));
    const payoutLockHash = parseHash32(text(body["payoutLockHash"], "payoutLockHash"));
    if (
      scriptIdentityHash(ownerLock) !== ownerLockHash ||
      scriptIdentityHash(payoutLock) !== payoutLockHash
    )
      throw new BadRequestException("reviewed lock hashes do not match their addresses");
    const identityPoint = outPoint(body["identityOutPoint"], "identityOutPoint");
    const principal = decimal(body["principal"], "principal");
    if (principal < MINIMUM_PRINCIPAL)
      throw new BadRequestException("original amount must be at least 242 CKB");
    const creatorNonce = parseSequence(text(body["creatorNonce"], "creatorNonce"));
    const totalCycles = body["totalCycles"];
    if (
      !Number.isSafeInteger(totalCycles) ||
      Number(totalCycles) < 1 ||
      Number(totalCycles) > MAXIMUM_CYCLES
    )
      throw new BadRequestException(`number of harvests must be between 1 and ${MAXIMUM_CYCLES}`);
    const preferredOperatorLockHash = parseHash32(
      text(body["preferredOperatorLockHash"], "preferredOperatorLockHash"),
    );
    const fallbackValue = body["fallbackOperatorLockHashes"];
    if (!Array.isArray(fallbackValue))
      throw new BadRequestException("fallbackOperatorLockHashes must be an array");
    const fallbackOperatorLockHashes = fallbackValue.map((value, index) =>
      parseHash32(text(value, `fallbackOperatorLockHashes[${index}]`)),
    );
    let operatorProof: Uint8Array;
    let fallbackSetHash: Uint8Array;
    try {
      const fallback = fallbackOperatorLockHashes.map(hexToBytes);
      operatorProof = encodeDaoHarvestV3FallbackOperatorProof(fallback);
      fallbackSetHash = deriveDaoHarvestV3FallbackOperatorSetHash(fallback);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "the fallback operator set is invalid",
      );
    }
    const identityCell = await this.#chain.getCellLive(identityPoint);
    if (
      !identityCell ||
      identityCell.cellOutput.type !== undefined ||
      identityCell.outputData.toString() !== "0x" ||
      scriptIdentityHash(chainLock(identityCell.cellOutput.lock)) !== ownerLockHash
    )
      throw new BadRequestException("the selected owner cell is no longer available");
    const deployment = this.#deployments[0];
    if (!deployment)
      throw new ServiceUnavailableException("the V3 contract revision is unavailable");
    const jobLock: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.jobLock.codeHash,
      hashType: "data1",
      args: "0x",
    });
    const policy: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.policy.codeHash,
      hashType: "data1",
      args: deployment.contracts.jobLock.codeHash as Hex,
    });
    const vaultType: ScriptIdentity = Object.freeze({
      codeHash: deployment.nervosDao.codeHash,
      hashType: "type",
      args: "0x",
    });
    const policyScriptHash = parseHash32(scriptToHash(policy));
    const jobLockHash = parseHash32(scriptToHash(jobLock));
    const daoTypeHash = parseHash32(scriptToHash(vaultType));
    const tip = await this.#chain.getTipHeader();
    const tipEpoch = parseEpoch(packClientEpoch(tip.epoch));
    const anticipatedDeposit = createEpoch({
      number: tipEpoch.number + 1n,
      index: 0n,
      length: 1n,
    });
    const window = selectDaoPrepareWindow({
      deposit: anticipatedDeposit,
      tip: anticipatedDeposit,
      bufferEpochs: PREPARE_BUFFER_EPOCHS,
      confirmationMarginEpochs: CONFIRMATION_MARGIN_EPOCHS,
    });
    const prepareBuffer = encodeRelativeEpochSince(
      createEpoch({ number: PREPARE_BUFFER_EPOCHS, index: 0n, length: 1n }),
    );
    const takeoverDelay = encodeRelativeEpochSince(
      createEpoch({ number: 0n, index: 1n, length: 20n }),
    );
    const confirmationMargin = encodeRelativeEpochSince(
      createEpoch({ number: CONFIRMATION_MARGIN_EPOCHS, index: 0n, length: 1n }),
    );
    const payloadBytes = DaoHarvestPayloadV3.pack({
      version: 3,
      owner_lock_hash: [...hexToBytes(ownerLockHash)],
      payout_lock_hash: [...hexToBytes(payoutLockHash)],
      vault_lock_code_hash: [...hexToBytes(deployment.contracts.vaultLock.codeHash)],
      compensation_lock_code_hash: [...hexToBytes(deployment.contracts.compensationLock.codeHash)],
      dao_type_hash: [...hexToBytes(daoTypeHash)],
      principal_capacity: principal.toString(),
      preferred_prepare_operator_lock_hash: [...hexToBytes(preferredOperatorLockHash)],
      fallback_prepare_executor_set_hash: [...fallbackSetHash],
      prepare_service_fee: PREPARE_SERVICE_FEE.toString(),
      claim_service_fee: CLAIM_SERVICE_FEE.toString(),
      compensation_seed_capacity: COMPENSATION_SEED.toString(),
      prepare_buffer_epochs: prepareBuffer.toString(),
      takeover_delay_epochs: takeoverDelay.toString(),
      confirmation_margin_epochs: confirmationMargin.toString(),
      total_cycles: Number(totalCycles),
      end_epoch_since: "0",
    });
    const payloadHashBytes = deriveDaoHarvestV3PayloadHash(
      hexToBytes(policyScriptHash),
      payloadBytes,
    );
    const jobIdBytes = deriveJobId({
      genesisHash: hexToBytes(deployment.genesisHash),
      protocolVersion: 3,
      creationCommitment: payloadHashBytes,
      anchor: { kind: "output_index", outputIndex: 0n },
      creatorNonce,
      policyScriptHash: hexToBytes(policyScriptHash),
    });
    const jobId = hash32FromBytes(jobIdBytes);
    const progressBytes = DaoHarvestProgressV3.pack({
      version: 3,
      state: 0,
      cycle_index: 0,
      prepare_credit_hash: Array(32).fill(0),
    });
    const progressHash = deriveDaoHarvestV3ProgressHash(progressBytes);
    const termsHash = deriveDaoHarvestV3VaultTermsHash([
      u16(3),
      hexToBytes(ownerLockHash),
      hexToBytes(payoutLockHash),
      hexToBytes(daoTypeHash),
      u64(principal),
      u64(PREPARE_SERVICE_FEE),
      u64(CLAIM_SERVICE_FEE),
      u64(COMPENSATION_SEED),
      u64(prepareBuffer),
      u64(takeoverDelay),
      u64(confirmationMargin),
      u32(Number(totalCycles)),
      u64(0n),
    ]);
    const vaultLock: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.vaultLock.codeHash,
      hashType: "data1",
      args: bytesToHex(
        encodeDaoHarvestV3VaultLockArgs({
          jobId: jobIdBytes,
          ownerLockHash: hexToBytes(ownerLockHash),
          jobLockHash: hexToBytes(jobLockHash),
          policyScriptHash: hexToBytes(policyScriptHash),
          immutableTermsHash: termsHash,
        }),
      ) as Hex,
    });
    const compensationLock: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.compensationLock.codeHash,
      hashType: "data1",
      args: bytesToHex(
        encodeDaoHarvestV3CompensationLockArgs({
          jobId: jobIdBytes,
          ownerLockHash: hexToBytes(ownerLockHash),
          payoutLockHash: hexToBytes(payoutLockHash),
          policyScriptHash: hexToBytes(policyScriptHash),
          payloadHash: payloadHashBytes,
        }),
      ) as Hex,
    });
    const jobData = JobDataV1.pack({
      version: 1,
      flags: 0,
      job_id: [...jobIdBytes],
      sequence: "0",
      state: 0,
      trigger_kind: 2,
      trigger_params_hash: [...progressHash],
      policy_script_hash: [...hexToBytes(policyScriptHash)],
      payload_hash: [...payloadHashBytes],
      reward: "0",
      remaining_budget: "0",
      not_before: encodeAbsoluteEpochSince(window.startsAt).toString(),
      not_after: "0",
      remaining_runs: Number(totalCycles),
      cancel_lock_hash: [...hexToBytes(ownerLockHash)],
    });
    const build = buildDaoHarvestV3Setup({
      context: {
        rpcGenesisHash: await this.#chain.getGenesisHash(),
        deployment,
        canonicalHeaderHashes: [],
        liveOutPoints: [txPoint(identityPoint)],
        signerLockHash: ownerLockHash,
      },
      policyScriptHash,
      ownerLockHash,
      payload: payloadBytes,
      progress: progressBytes,
      operatorProof,
      inputs: { identity: reviewed(identityCell, identityPoint) },
      outputs: {
        job: output(JOB_CAPACITY, jobLock, policy, bytesToHex(jobData) as Hex),
        vault: output(principal, vaultLock, vaultType, "0x0000000000000000"),
        compensation: output(COMPENSATION_SEED, compensationLock, null),
      },
      maximumNetworkFee: MAXIMUM_NETWORK_FEE,
      allowedFundingLockHashes: [ownerLockHash],
    });
    return Object.freeze({
      version: 3,
      jobId,
      operation: "setup",
      chain: Object.freeze({
        genesisHash: deployment.genesisHash,
        manifestSha256: deployment.manifestSha256,
      }),
      transaction: build.transaction,
      intentHash: build.intentHash,
      review: Object.freeze({
        protectedAmount: principal.toString(),
        maximumNetworkFee: MAXIMUM_NETWORK_FEE.toString(),
        totalInput: build.value.totalInput.toString(),
        totalOutput: build.value.totalOutput.toString(),
      }),
      completion: Object.freeze({
        ...build.completion,
        requiredInputCapacity: build.completion.requiredInputCapacity.toString(),
        maximumFee: build.completion.maximumFee.toString(),
      }),
    });
  }
}
