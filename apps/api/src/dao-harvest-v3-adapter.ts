import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";
import {
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  buildDaoHarvestV3OwnerExit,
  buildDaoHarvestV3OwnerRecovery,
  calculateDaoMaximumWithdraw,
  compareEpochFractions,
  decodeAbsoluteEpochSince,
  parseHash32,
  parseEpoch,
  parseOutPoint,
  parseShannons,
  scriptIdentityHash,
  type DaoHarvestV3DeploymentIdentity,
  type DaoHarvestV3ReviewedInput,
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

export function daoHarvestV3PolicyScriptHash(value: {
  readonly codeHash: unknown;
  readonly hashType: unknown;
  readonly args: unknown;
}) {
  return parseHash32(scriptToHash(chainLock(value)));
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
    if (operation !== "owner-exit" && operation !== "owner-recovery")
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
    const payloadBytes = hexToBytes(text(projection["payload"], "payload"));
    const progressBytes = hexToBytes(text(projection["progress"], "progress"));
    const payload = DaoHarvestPayloadV3.unpack(payloadBytes);
    const progress = DaoHarvestProgressV3.unpack(progressBytes);
    const deployment = this.#deployments.find(
      (candidate) =>
        candidate.contracts.vaultLock.codeHash ===
          bytesToHex(Uint8Array.from(payload.vault_lock_code_hash)) &&
        candidate.contracts.compensationLock.codeHash ===
          bytesToHex(Uint8Array.from(payload.compensation_lock_code_hash)),
    );
    if (!deployment)
      throw new ServiceUnavailableException("the V3 contract revision is unavailable");
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
    if (operation === "owner-exit") {
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
        throw new BadRequestException("owner recovery requires a withdrawing V3 position");
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
        headerDeps: [parseHash32(depositBlock.header.hash), parseHash32(prepareBlock.header.hash)],
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
}
