import { createHash, randomUUID } from "node:crypto";

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { and, desc, eq, getTableColumns, inArray, lt, or } from "drizzle-orm";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import { clientDaoAccumulatedRate, packClientEpoch } from "@ckb-automata/ccc";
import {
  DAO_HARVEST_JOB_OCCUPIED_CAPACITY,
  DAO_HARVEST_QUOTE_VALID_BLOCKS,
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  addEpochs,
  buildDaoHarvestSetup,
  calculateDaoHarvestQuote,
  createEpoch,
  deploymentRegistry,
  encodeAbsoluteEpochSince,
  encodeRelativeEpochSince,
  parseEpoch,
  parseHash32,
  parseShannons,
  registeredDaoHarvestDeployment,
  selectDaoPrepareWindow,
  type DeploymentRegistry,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import type { CkbReadClient } from "./ckb-client.ts";
import type { AutomataDatabase } from "./database/client.ts";
import { daoHarvestJobs, jobs, transactionAttempts } from "./database/schema.ts";
import { extractDaoHarvestProjections } from "./indexer/dao-harvest-projection.ts";
import type { LockResolutionRecorder } from "./lock-resolutions.ts";
import {
  TransactionProgressService,
  type TransactionProgress,
  type TransactionProgressState,
} from "./transaction-progress.ts";

const HASH = /^0x[0-9a-f]{64}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const DAO_HARVEST_READ_STATES = [
  "deposited",
  "withdrawing",
  "claim_ready",
  "completed",
  "recovery_required",
] as const;
export type DaoHarvestReadState = (typeof DAO_HARVEST_READ_STATES)[number];

export interface DaoHarvestReadModel {
  readonly jobId: string;
  readonly ownerLockHash: string;
  readonly state: DaoHarvestReadState;
  readonly vaultOutPoint: { readonly txHash: string; readonly index: string };
  readonly schedule: {
    readonly depositEpochSince: string;
    readonly prepareStartSince: string;
    readonly prepareCutoffSince: string;
    readonly claimMaturitySince: string | null;
  };
  readonly progress: { readonly completedCycles: string; readonly totalCycles: string };
  readonly principal: string;
  readonly payoutLockHash: string;
  readonly economics: unknown;
  readonly source: {
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly canonical: boolean;
  };
  readonly updatedAt: string;
}

export interface DaoHarvestListResponse {
  readonly items: readonly DaoHarvestReadModel[];
  readonly pendingItems: readonly PendingDaoHarvestReadModel[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
}

export interface PendingDaoHarvestReadModel {
  readonly jobId: string;
  readonly ownerLockHash: string;
  readonly payoutLockHash: string;
  readonly principal: string;
  readonly progress: { readonly completedCycles: "0"; readonly totalCycles: string };
  readonly status: "confirming" | "submitting" | "waiting";
  readonly confirmations: string;
  readonly requiredConfirmations: number;
  readonly submittedAt: string;
  readonly transactionHash: string;
}

export interface DaoHarvestQuoteReadModel {
  readonly quoteId: string;
  readonly jobId: string;
  readonly state: DaoHarvestReadState;
  readonly economics: unknown;
  readonly chainSnapshot: { readonly blockNumber: string; readonly blockHash: string };
  readonly expiry: { readonly condition: "canonical_harvest_snapshot"; readonly blockHash: string };
}

export interface DaoHarvestUnsignedBuild {
  readonly operation: "setup" | "stop" | "exit" | "recover";
  readonly transaction: UnsignedDeadlineTransaction;
  readonly signingEntries: readonly unknown[];
  readonly intent: unknown;
  readonly policyCriticalHash: string;
  readonly jobId?: string;
}

export interface DaoHarvestMutationAdapter {
  build(
    operation: DaoHarvestUnsignedBuild["operation"],
    body: unknown,
  ): Promise<DaoHarvestUnsignedBuild>;
}

const SETUP_KEYS = [
  "lockResolutions",
  "ownerLockHash",
  "payoutLockHash",
  "principal",
  "totalCycles",
] as const;
const EXECUTOR_REWARD = 61n * 100_000_000n;
const ESTIMATED_NETWORK_FEE = 1n * 100_000_000n;
const PREPARE_BUFFER_EPOCHS = 4n;
const CONFIRMATION_MARGIN_EPOCHS = 1n;
interface SetupRequest {
  readonly ownerLockHash: string;
  readonly payoutLockHash: string;
  readonly principal: string;
  readonly totalCycles: number;
  readonly lockResolutions: readonly ScriptIdentity[];
}

function lockResolution(value: unknown, name: string): ScriptIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a lock script`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).toSorted().join(",") !== "args,codeHash,hashType" ||
    typeof record["codeHash"] !== "string" ||
    typeof record["args"] !== "string" ||
    (record["hashType"] !== "data" &&
      record["hashType"] !== "data1" &&
      record["hashType"] !== "type") ||
    !/^0x(?:[0-9a-f]{2})*$/.test(record["args"])
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({
    codeHash: parseHash32(record["codeHash"]),
    hashType: record["hashType"],
    args: record["args"] as `0x${string}`,
  });
}

function setupRequest(value: unknown): SetupRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException("DAO harvest setup must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== SETUP_KEYS.length ||
    SETUP_KEYS.some((key) => !(key in record))
  ) {
    throw new BadRequestException("DAO harvest setup contains unsupported fields");
  }
  const ownerLockHash = record["ownerLockHash"];
  const payoutLockHash = record["payoutLockHash"];
  const principal = record["principal"];
  const totalCycles = record["totalCycles"];
  const lockResolutions = record["lockResolutions"];
  if (
    typeof ownerLockHash !== "string" ||
    typeof payoutLockHash !== "string" ||
    typeof principal !== "string" ||
    typeof totalCycles !== "number" ||
    !Array.isArray(lockResolutions) ||
    lockResolutions.length !== 2
  ) {
    throw new BadRequestException("DAO harvest setup fields have invalid types");
  }
  try {
    const ownerHash = parseHash32(ownerLockHash);
    const payoutHash = parseHash32(payoutLockHash);
    const locks = lockResolutions.map((lock, index) =>
      lockResolution(lock, `lockResolutions[${index}]`),
    );
    const hashes = locks.map((lock) => parseHash32(scriptToHash(lock)));
    if (new Set(hashes).size !== 2 || !hashes.includes(ownerHash) || !hashes.includes(payoutHash)) {
      throw new TypeError("lock resolutions must match the owner and payout hashes");
    }
    if (parseShannons(principal) < DAO_HARVEST_VAULT_OCCUPIED_CAPACITY) {
      throw new RangeError("original amount must be at least 210 CKB");
    }
    if (!Number.isSafeInteger(totalCycles) || totalCycles < 1 || totalCycles > 12) {
      throw new RangeError("number of harvests must be between 1 and 12");
    }
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : "invalid setup");
  }
  return Object.freeze({
    ownerLockHash,
    payoutLockHash,
    principal,
    totalCycles,
    lockResolutions: Object.freeze(
      lockResolutions.map((lock, index) => lockResolution(lock, `lockResolutions[${index}]`)),
    ),
  });
}

export class DaoHarvestTransactionAdapter implements DaoHarvestMutationAdapter {
  readonly #chain: Pick<CkbReadClient, "getTipHeader">;
  readonly #expectedGenesisHash: string;
  readonly #registry: Pick<DeploymentRegistry, "load">;
  readonly #resolutions: LockResolutionRecorder;

  constructor(
    chain: Pick<CkbReadClient, "getTipHeader">,
    expectedGenesisHash: string,
    resolutions: LockResolutionRecorder,
    registry: Pick<DeploymentRegistry, "load"> = deploymentRegistry,
  ) {
    this.#chain = chain;
    this.#expectedGenesisHash = expectedGenesisHash;
    this.#resolutions = resolutions;
    this.#registry = registry;
  }

  async build(
    operation: DaoHarvestUnsignedBuild["operation"],
    body: unknown,
  ): Promise<DaoHarvestUnsignedBuild> {
    if (operation !== "setup") {
      throw new ServiceUnavailableException(
        "This owner action is available after a harvest automation is indexed",
      );
    }
    const request = setupRequest(body);
    const registered = await this.#registry.load(this.#expectedGenesisHash);
    if (registered.status !== "ok" || registered.deployment.manifest.daoHarvest === undefined) {
      throw new ServiceUnavailableException("DAO harvest is not active on this deployment");
    }
    const deployment = registeredDaoHarvestDeployment(registered.deployment);
    const tip = await this.#chain.getTipHeader();
    const tipEpoch = parseEpoch(packClientEpoch(tip.epoch));
    const anticipatedDepositEpoch = addEpochs(tipEpoch, 1n);
    const window = selectDaoPrepareWindow({
      deposit: anticipatedDepositEpoch,
      tip: anticipatedDepositEpoch,
      bufferEpochs: PREPARE_BUFFER_EPOCHS,
      confirmationMarginEpochs: CONFIRMATION_MARGIN_EPOCHS,
    });
    const actions = BigInt(request.totalCycles) * 2n;
    const rate = clientDaoAccumulatedRate(tip.dao);
    const quote = calculateDaoHarvestQuote({
      principal: request.principal,
      occupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
      depositAccumulatedRate: rate,
      projectedWithdrawAccumulatedRate: rate,
      executorReward: EXECUTOR_REWARD,
      actions,
      estimatedNetworkFee: ESTIMATED_NETWORK_FEE,
      snapshotBlock: tip.number.toString(),
      validUntilBlock: BigInt(tip.number.toString()) + DAO_HARVEST_QUOTE_VALID_BLOCKS,
    });
    const build = buildDaoHarvestSetup({
      deployment,
      expectedGenesisHash: parseHash32(this.#expectedGenesisHash),
      ownerLockHash: parseHash32(request.ownerLockHash),
      payoutLockHash: parseHash32(request.payoutLockHash),
      principal: request.principal,
      vaultOccupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
      jobOccupiedCapacity: DAO_HARVEST_JOB_OCCUPIED_CAPACITY,
      prepareExecutorLockHashes:
        registered.deployment.manifest.daoHarvest.prepareExecutorLockHashes,
      executorReward: EXECUTOR_REWARD,
      minCompensation: 1n,
      prepareBufferEpochs: encodeRelativeEpochSince(
        createEpoch({ number: PREPARE_BUFFER_EPOCHS, index: 0n, length: 0n }),
      ),
      confirmationMarginEpochs: encodeRelativeEpochSince(
        createEpoch({ number: CONFIRMATION_MARGIN_EPOCHS, index: 0n, length: 0n }),
      ),
      totalCycles: BigInt(request.totalCycles),
      endEpochSince: 0n,
      firstPrepareSince: encodeAbsoluteEpochSince(window.startsAt),
      creatorNonce: tip.number.toString(),
      quote,
      currentBlock: tip.number.toString(),
    });
    await this.#resolutions.remember(request.lockResolutions);
    return Object.freeze({
      operation: "setup" as const,
      transaction: build.transaction,
      signingEntries: build.signingEntries,
      intent: build.intent,
      policyCriticalHash: build.payloadHash,
      jobId: build.jobId,
    });
  }
}

type Row = typeof daoHarvestJobs.$inferSelect & { readonly ownerLockHash: string };

function hash(value: string, name: string): string {
  if (!HASH.test(value)) throw new BadRequestException(`${name} must be a lowercase 32-byte hash`);
  return value;
}

function limit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (Array.isArray(value) || typeof value === "object" || value === null) {
    throw new BadRequestException("limit must be provided once");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

function cursor(value: unknown): { readonly block: string; readonly jobId: string } | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 256)
    throw new BadRequestException("cursor is invalid");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate["block"] !== "string" || typeof candidate["jobId"] !== "string")
      throw new Error();
    if (!/^(0|[1-9][0-9]*)$/.test(candidate["block"]) || !HASH.test(candidate["jobId"]))
      throw new Error();
    return { block: candidate["block"], jobId: candidate["jobId"] };
  } catch {
    throw new BadRequestException("cursor is invalid");
  }
}

function encodeCursor(row: Row): string {
  return Buffer.from(
    JSON.stringify({ block: row.observedBlockNumber, jobId: row.jobId }),
    "utf8",
  ).toString("base64url");
}

function readModel(row: Row): DaoHarvestReadModel {
  return Object.freeze({
    jobId: row.jobId,
    ownerLockHash: row.ownerLockHash,
    state: row.vaultState as DaoHarvestReadState,
    vaultOutPoint: Object.freeze({
      txHash: row.vaultOutpointTxHash,
      index: row.vaultOutpointIndex,
    }),
    schedule: Object.freeze({
      depositEpochSince: row.depositEpochSince,
      prepareStartSince: row.prepareStartSince,
      prepareCutoffSince: row.prepareCutoffSince,
      claimMaturitySince: row.claimMaturitySince,
    }),
    progress: Object.freeze({
      completedCycles: row.completedCycles,
      totalCycles: row.totalCycles,
    }),
    principal: row.principalCapacity,
    payoutLockHash: row.payoutLockHash,
    economics: row.economicsSnapshot,
    source: Object.freeze({
      blockNumber: row.observedBlockNumber,
      blockHash: row.observedBlockHash,
      canonical: row.canonical,
    }),
    updatedAt: row.updatedAt.toISOString(),
  });
}

const ACTIVE_SUBMISSION_STATES = ["submitted", "proposed", "committed", "confirmed"] as const;

interface PendingDaoHarvestMetadata {
  readonly jobId: string;
  readonly ownerLockHash: string;
  readonly payoutLockHash: string;
  readonly principal: string;
  readonly totalCycles: string;
}

interface StoredPendingDaoHarvest extends PendingDaoHarvestMetadata {
  readonly kind: "pending_dao_harvest";
}

function pendingMetadata(value: unknown): StoredPendingDaoHarvest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    item["kind"] !== "pending_dao_harvest" ||
    typeof item["jobId"] !== "string" ||
    !HASH.test(item["jobId"]) ||
    typeof item["ownerLockHash"] !== "string" ||
    !HASH.test(item["ownerLockHash"]) ||
    typeof item["payoutLockHash"] !== "string" ||
    !HASH.test(item["payoutLockHash"]) ||
    typeof item["principal"] !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(item["principal"]) ||
    typeof item["totalCycles"] !== "string" ||
    !/^[1-9][0-9]*$/.test(item["totalCycles"])
  ) {
    return undefined;
  }
  return item as unknown as StoredPendingDaoHarvest;
}

function submissionHash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new BadRequestException("transactionHash must be a lowercase 32-byte hash");
  }
  return value;
}

function submissionStatus(state: TransactionProgressState): PendingDaoHarvestReadModel["status"] {
  if (state === "submitted") return "submitting";
  if (state === "confirmed") return "waiting";
  return "confirming";
}

function pendingReadModel(
  metadata: PendingDaoHarvestMetadata,
  transactionHash: string,
  submittedAt: Date,
  progress: Pick<TransactionProgress, "confirmations" | "requiredConfirmations" | "state">,
): PendingDaoHarvestReadModel {
  return Object.freeze({
    jobId: metadata.jobId,
    ownerLockHash: metadata.ownerLockHash,
    payoutLockHash: metadata.payoutLockHash,
    principal: metadata.principal,
    progress: Object.freeze({ completedCycles: "0" as const, totalCycles: metadata.totalCycles }),
    status: submissionStatus(progress.state),
    confirmations: progress.confirmations,
    requiredConfirmations: progress.requiredConfirmations,
    submittedAt: submittedAt.toISOString(),
    transactionHash,
  });
}

export class DaoHarvestPendingService {
  readonly #chain: Pick<CkbReadClient, "getTipHeader" | "getTransactionStatus">;
  readonly #database: AutomataDatabase;
  readonly #genesisHash: string;
  readonly #network: string;
  readonly #progress: TransactionProgressService;
  readonly #registry: DeploymentRegistry;

  constructor(
    database: AutomataDatabase,
    network: string,
    genesisHash: string,
    chain: Pick<CkbReadClient, "getTipHeader" | "getTransactionStatus">,
    progress: TransactionProgressService,
    registry: DeploymentRegistry = deploymentRegistry,
  ) {
    this.#database = database;
    this.#network = network;
    this.#genesisHash = genesisHash;
    this.#chain = chain;
    this.#progress = progress;
    this.#registry = registry;
  }

  async register(input: unknown): Promise<PendingDaoHarvestReadModel> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new BadRequestException("DAO harvest submission must be an object");
    }
    const body = input as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || !("transactionHash" in body)) {
      throw new BadRequestException("DAO harvest submission contains unsupported fields");
    }
    const transactionHash = submissionHash(body["transactionHash"]);
    const [registered, observed, tip] = await Promise.all([
      this.#registry.load(this.#genesisHash),
      this.#chain.getTransactionStatus(transactionHash),
      this.#chain.getTipHeader(),
    ]);
    if (registered.status !== "ok" || registered.deployment.manifest.daoHarvest === undefined) {
      throw new ServiceUnavailableException("DAO harvest is not active on this deployment");
    }
    if (
      observed === undefined ||
      !["sent", "pending", "proposed", "committed"].includes(observed.status) ||
      parseHash32(observed.transaction.hash()) !== transactionHash
    ) {
      throw new BadRequestException("The submitted DAO harvest transaction is not known on CKB");
    }
    const extraction = extractDaoHarvestProjections(
      {
        header: tip,
        transactions: [observed.transaction],
      } as never,
      registeredDaoHarvestDeployment(registered.deployment),
    );
    const projection = extraction.projections[0];
    if (
      projection === undefined ||
      extraction.projections.length !== 1 ||
      extraction.malformed > 0
    ) {
      throw new BadRequestException("The submitted transaction is not a valid DAO harvest setup");
    }
    const metadata = Object.freeze({
      jobId: projection.jobId,
      ownerLockHash: projection.ownerLockHash,
      payoutLockHash: projection.payoutLockHash,
      principal: projection.principalCapacity.toString(),
      totalCycles: projection.totalCycles.toString(),
    });
    const submittedAt = new Date();
    await this.#database
      .insert(transactionAttempts)
      .values({
        id: randomUUID(),
        networkId: this.#network,
        operation: "create",
        simulation: { kind: "pending_dao_harvest", ...metadata } satisfies StoredPendingDaoHarvest,
        state: "submitted",
        submittedAt,
        txHash: transactionHash,
      })
      .onConflictDoNothing();
    const progress = await this.#readProgress(transactionHash, submittedAt, "submitted");
    return pendingReadModel(metadata, transactionHash, submittedAt, progress);
  }

  async list(): Promise<readonly PendingDaoHarvestReadModel[]> {
    const rows = await this.#database
      .select()
      .from(transactionAttempts)
      .where(
        and(
          eq(transactionAttempts.networkId, this.#network),
          eq(transactionAttempts.operation, "create"),
          inArray(transactionAttempts.state, [...ACTIVE_SUBMISSION_STATES]),
        ),
      )
      .orderBy(desc(transactionAttempts.submittedAt));
    const candidates = rows.flatMap((row) => {
      const metadata = pendingMetadata(row.simulation);
      return metadata === undefined || row.txHash === null || row.submittedAt === null
        ? []
        : [{ metadata, row }];
    });
    const jobIds = [...new Set(candidates.map(({ metadata }) => metadata.jobId))];
    const indexed =
      jobIds.length === 0
        ? []
        : await this.#database
            .select({ jobId: daoHarvestJobs.jobId })
            .from(daoHarvestJobs)
            .where(
              and(
                eq(daoHarvestJobs.networkId, this.#network),
                inArray(daoHarvestJobs.jobId, jobIds),
              ),
            );
    const indexedJobIds = new Set(indexed.map(({ jobId }) => jobId));
    const items: PendingDaoHarvestReadModel[] = [];
    for (const { metadata, row } of candidates) {
      if (indexedJobIds.has(metadata.jobId)) continue;
      const progress = await this.#readProgress(row.txHash!, row.submittedAt!, row.state);
      if (
        !ACTIVE_SUBMISSION_STATES.includes(
          progress.state as (typeof ACTIVE_SUBMISSION_STATES)[number],
        )
      ) {
        await this.#database
          .update(transactionAttempts)
          .set({ state: progress.state, updatedAt: new Date() })
          .where(eq(transactionAttempts.id, row.id));
        continue;
      }
      if (row.state !== progress.state) {
        await this.#database
          .update(transactionAttempts)
          .set({
            state: progress.state,
            ...(progress.block === null ? {} : { committedBlockNumber: progress.block.number }),
            ...(progress.state === "confirmed"
              ? { confirmedAt: new Date(progress.observedAt) }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(transactionAttempts.id, row.id));
      }
      items.push(pendingReadModel(metadata, row.txHash!, row.submittedAt!, progress));
    }
    return Object.freeze(items);
  }

  async #readProgress(
    transactionHash: string,
    submittedAt: Date,
    fallbackState: string,
  ): Promise<TransactionProgress> {
    try {
      return await this.#progress.read(transactionHash, {
        submittedAt: submittedAt.toISOString(),
      });
    } catch {
      return {
        block: null,
        confirmations: "0",
        observedAt: new Date().toISOString(),
        reason: null,
        requiredConfirmations: 1,
        state: ACTIVE_SUBMISSION_STATES.includes(
          fallbackState as (typeof ACTIVE_SUBMISSION_STATES)[number],
        )
          ? (fallbackState as TransactionProgressState)
          : "submitted",
        transactionHash: parseHash32(transactionHash),
      };
    }
  }
}

export class DaoHarvestReadService {
  readonly #database: AutomataDatabase;
  readonly #network: string;
  readonly #pending: Pick<DaoHarvestPendingService, "list"> | undefined;

  constructor(
    database: AutomataDatabase,
    network: string,
    pending?: Pick<DaoHarvestPendingService, "list">,
  ) {
    this.#database = database;
    this.#network = network;
    this.#pending = pending;
  }

  async list(query: {
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<DaoHarvestListResponse> {
    const pageLimit = limit(query.limit);
    const pageCursor = cursor(query.cursor);
    const conditions = [eq(daoHarvestJobs.networkId, this.#network)];
    if (pageCursor) {
      conditions.push(
        or(
          lt(daoHarvestJobs.observedBlockNumber, pageCursor.block),
          and(
            eq(daoHarvestJobs.observedBlockNumber, pageCursor.block),
            lt(daoHarvestJobs.jobId, pageCursor.jobId),
          ),
        )!,
      );
    }
    const rows = await this.#database
      .select({ ...getTableColumns(daoHarvestJobs), ownerLockHash: jobs.ownerLockHash })
      .from(daoHarvestJobs)
      .innerJoin(
        jobs,
        and(eq(jobs.networkId, daoHarvestJobs.networkId), eq(jobs.jobId, daoHarvestJobs.jobId)),
      )
      .where(and(...conditions))
      .orderBy(desc(daoHarvestJobs.observedBlockNumber), desc(daoHarvestJobs.jobId))
      .limit(pageLimit + 1);
    const hasMore = rows.length > pageLimit;
    const selected = rows.slice(0, pageLimit) as Row[];
    const pendingItems = pageCursor === null ? ((await this.#pending?.list()) ?? []) : [];
    return Object.freeze({
      items: Object.freeze(selected.map(readModel)),
      pendingItems,
      page: Object.freeze({
        limit: pageLimit,
        nextCursor: hasMore && selected.at(-1) ? encodeCursor(selected.at(-1)!) : null,
      }),
    });
  }

  async detail(jobIdInput: string): Promise<DaoHarvestReadModel> {
    const jobId = hash(jobIdInput, "jobId");
    const [row] = await this.#database
      .select({ ...getTableColumns(daoHarvestJobs), ownerLockHash: jobs.ownerLockHash })
      .from(daoHarvestJobs)
      .innerJoin(
        jobs,
        and(eq(jobs.networkId, daoHarvestJobs.networkId), eq(jobs.jobId, daoHarvestJobs.jobId)),
      )
      .where(and(eq(daoHarvestJobs.networkId, this.#network), eq(daoHarvestJobs.jobId, jobId)))
      .limit(1);
    if (!row) throw new NotFoundException("DAO harvest automation was not found");
    return readModel(row as Row);
  }

  async quote(jobId: string): Promise<DaoHarvestQuoteReadModel> {
    const item = await this.detail(jobId);
    const body = {
      jobId: item.jobId,
      state: item.state,
      economics: item.economics,
      chainSnapshot: item.source,
    };
    return Object.freeze({
      quoteId: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      jobId: item.jobId,
      state: item.state,
      economics: item.economics,
      chainSnapshot: Object.freeze({
        blockNumber: item.source.blockNumber,
        blockHash: item.source.blockHash,
      }),
      expiry: Object.freeze({
        condition: "canonical_harvest_snapshot" as const,
        blockHash: item.source.blockHash,
      }),
    });
  }
}

export class DaoHarvestMutationService {
  readonly #adapter: DaoHarvestMutationAdapter | undefined;

  constructor(adapter?: DaoHarvestMutationAdapter) {
    this.#adapter = adapter;
  }

  build(
    operation: DaoHarvestUnsignedBuild["operation"],
    body: unknown,
  ): Promise<DaoHarvestUnsignedBuild> {
    if (!this.#adapter) {
      throw new ServiceUnavailableException("DAO harvest transaction building is not deployed");
    }
    return this.#adapter.build(operation, body);
  }
}

export class DaoHarvestController {
  readonly #reads: DaoHarvestReadService;
  readonly #mutations: DaoHarvestMutationService;
  readonly #pending: DaoHarvestPendingService;

  constructor(
    reads: DaoHarvestReadService,
    mutations: DaoHarvestMutationService,
    pending: DaoHarvestPendingService,
  ) {
    this.#reads = reads;
    this.#mutations = mutations;
    this.#pending = pending;
  }

  list(query: {
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<DaoHarvestListResponse> {
    return this.#reads.list(query);
  }
  detail(jobId: string): Promise<DaoHarvestReadModel> {
    return this.#reads.detail(jobId);
  }
  quote(jobId: string): Promise<DaoHarvestQuoteReadModel> {
    return this.#reads.quote(jobId);
  }
  setup(body: unknown): Promise<DaoHarvestUnsignedBuild> {
    return this.#mutations.build("setup", body);
  }
  registerSetup(body: unknown): Promise<PendingDaoHarvestReadModel> {
    return this.#pending.register(body);
  }
  stop(body: unknown): Promise<DaoHarvestUnsignedBuild> {
    return this.#mutations.build("stop", body);
  }
  exit(body: unknown): Promise<DaoHarvestUnsignedBuild> {
    return this.#mutations.build("exit", body);
  }
  recover(body: unknown): Promise<DaoHarvestUnsignedBuild> {
    return this.#mutations.build("recover", body);
  }
}

const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const decimalSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const lockScriptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["args", "codeHash", "hashType"],
  properties: {
    args: { type: "string", pattern: "^0x(?:[0-9a-f]{2})*$" },
    codeHash: hashSchema,
    hashType: { type: "string", enum: ["data", "data1", "type"] },
  },
};
const harvestSetupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lockResolutions", "ownerLockHash", "payoutLockHash", "principal", "totalCycles"],
  properties: {
    lockResolutions: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: lockScriptSchema,
    },
    ownerLockHash: hashSchema,
    payoutLockHash: hashSchema,
    principal: decimalSchema,
    totalCycles: { type: "integer", minimum: 1, maximum: 12 },
  },
};
const harvestSchema = {
  type: "object",
  required: [
    "jobId",
    "ownerLockHash",
    "state",
    "vaultOutPoint",
    "schedule",
    "progress",
    "principal",
    "payoutLockHash",
    "economics",
    "source",
    "updatedAt",
  ],
  properties: {
    jobId: hashSchema,
    ownerLockHash: hashSchema,
    state: { type: "string", enum: [...DAO_HARVEST_READ_STATES] },
    vaultOutPoint: { type: "object" },
    schedule: {
      type: "object",
      required: [
        "depositEpochSince",
        "prepareStartSince",
        "prepareCutoffSince",
        "claimMaturitySince",
      ],
      properties: {
        depositEpochSince: decimalSchema,
        prepareStartSince: decimalSchema,
        prepareCutoffSince: decimalSchema,
        claimMaturitySince: { ...decimalSchema, nullable: true },
      },
    },
    progress: {
      type: "object",
      required: ["completedCycles", "totalCycles"],
      properties: { completedCycles: decimalSchema, totalCycles: decimalSchema },
    },
    principal: decimalSchema,
    payoutLockHash: hashSchema,
    economics: { type: "object" },
    source: { type: "object" },
    updatedAt: { type: "string", format: "date-time" },
  },
};
const pendingHarvestSchema = {
  type: "object",
  required: [
    "jobId",
    "ownerLockHash",
    "payoutLockHash",
    "principal",
    "progress",
    "status",
    "confirmations",
    "requiredConfirmations",
    "submittedAt",
    "transactionHash",
  ],
  properties: {
    jobId: hashSchema,
    ownerLockHash: hashSchema,
    payoutLockHash: hashSchema,
    principal: decimalSchema,
    progress: {
      type: "object",
      required: ["completedCycles", "totalCycles"],
      properties: {
        completedCycles: { type: "string", enum: ["0"] },
        totalCycles: decimalSchema,
      },
    },
    status: { type: "string", enum: ["submitting", "confirming", "waiting"] },
    confirmations: decimalSchema,
    requiredConfirmations: { type: "integer", minimum: 1 },
    submittedAt: { type: "string", format: "date-time" },
    transactionHash: hashSchema,
  },
};

Injectable()(DaoHarvestReadService);
Injectable()(DaoHarvestPendingService);
Injectable()(DaoHarvestMutationService);
Inject(DaoHarvestReadService)(DaoHarvestController, undefined, 0);
Inject(DaoHarvestMutationService)(DaoHarvestController, undefined, 1);
Inject(DaoHarvestPendingService)(DaoHarvestController, undefined, 2);
Controller("dao-harvest")(DaoHarvestController);
ApiTags("DAO harvest")(DaoHarvestController);

const registerSetupDescriptor = Object.getOwnPropertyDescriptor(
  DaoHarvestController.prototype,
  "registerSetup",
)!;
Post("register-setup")(DaoHarvestController.prototype, "registerSetup", registerSetupDescriptor);
HttpCode(200)(DaoHarvestController.prototype, "registerSetup", registerSetupDescriptor);
Body()(DaoHarvestController.prototype, "registerSetup", 0);
ApiOperation({ summary: "Register a submitted DAO harvest setup while it confirms" })(
  DaoHarvestController.prototype,
  "registerSetup",
  registerSetupDescriptor,
);
ApiBody({
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["transactionHash"],
    properties: { transactionHash: hashSchema },
  },
})(DaoHarvestController.prototype, "registerSetup", registerSetupDescriptor);
ApiOkResponse({ schema: pendingHarvestSchema })(
  DaoHarvestController.prototype,
  "registerSetup",
  registerSetupDescriptor,
);
ApiBadRequestResponse({ description: "Malformed or unknown DAO harvest submission" })(
  DaoHarvestController.prototype,
  "registerSetup",
  registerSetupDescriptor,
);

for (const [method, path, summary] of [
  ["setup", "setup", "Build an unsigned DAO harvest setup transaction"],
  ["stop", "stop", "Build an unsigned stop-recurrence transaction"],
  ["exit", "exit", "Build an unsigned owner exit transaction"],
  ["recover", "recover", "Build an unsigned owner recovery transaction"],
] as const) {
  Post(path)(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  Body()(DaoHarvestController.prototype, method, 0);
  ApiOperation({ summary })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiBody({ schema: method === "setup" ? harvestSetupSchema : { type: "object" } })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiOkResponse({ description: "Unsigned transaction and review intent" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiBadRequestResponse({ description: "Malformed or stale request" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiServiceUnavailableResponse({ description: "Harvest deployment or chain read unavailable" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
}

Get()(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);
Query()(DaoHarvestController.prototype, "list", 0);
ApiOperation({ summary: "List submitted and indexed DAO harvest automations" })(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);
ApiQuery({ name: "cursor", required: false, type: String })(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);
ApiQuery({ name: "limit", required: false, type: Number })(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["items", "pendingItems", "page"],
    properties: {
      items: { type: "array", items: harvestSchema },
      pendingItems: { type: "array", items: pendingHarvestSchema },
      page: { type: "object" },
    },
  },
})(
  DaoHarvestController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, "list")!,
);

for (const [method, suffix, summary, schema] of [
  ["detail", ":jobId", "Read one DAO harvest automation", harvestSchema],
  ["quote", ":jobId/quote", "Read a canonical DAO harvest economics quote", { type: "object" }],
] as const) {
  Get(suffix)(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  Param("jobId")(DaoHarvestController.prototype, method, 0);
  ApiOperation({ summary })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiParam({ name: "jobId", schema: hashSchema })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiOkResponse({ schema })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiBadRequestResponse({ description: "Malformed job ID" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
  ApiNotFoundResponse({ description: "DAO harvest automation not found" })(
    DaoHarvestController.prototype,
    method,
    Object.getOwnPropertyDescriptor(DaoHarvestController.prototype, method)!,
  );
}
