import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, lt } from "drizzle-orm";
import type { AutomataDatabase } from "./database/client.ts";
import { daoHarvestV3Jobs } from "./database/schema.ts";

const HASH = /^0x[0-9a-f]{64}$/;
const OPERATIONS = [
  "setup",
  "sweep",
  "close",
  "rotate",
  "owner-exit",
  "owner-recovery",
  "owner-complete",
] as const;
export type DaoHarvestV3BuildOperation = (typeof OPERATIONS)[number];
export interface DaoHarvestV3ReadModel {
  readonly version: 3;
  readonly jobId: string;
  readonly ownerLockHash: string;
  readonly state: string;
  readonly operation: string;
  readonly principalCapacity: string;
  readonly progress: { readonly cycle: string; readonly totalCycles: string };
  readonly cells: {
    readonly job: unknown;
    readonly daoVault: unknown;
    readonly compensation: unknown;
  };
  readonly prepareCredit: unknown;
  readonly terminalOwnerControl: boolean;
  readonly evidence: {
    readonly canonical: true;
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly transactionHash: string;
  };
  readonly updatedAt: string;
}
export interface DaoHarvestV3MutationAdapter {
  build(operation: DaoHarvestV3BuildOperation, body: unknown): Promise<unknown>;
}
function hash(value: unknown, name: string) {
  if (typeof value !== "string" || !HASH.test(value))
    throw new BadRequestException(`${name} must be a lowercase 32-byte hash`);
  return value;
}
function rowModel(row: typeof daoHarvestV3Jobs.$inferSelect): DaoHarvestV3ReadModel {
  if (
    typeof row.projection !== "object" ||
    row.projection === null ||
    Array.isArray(row.projection)
  )
    throw new Error("stored V3 job projection is invalid");
  const value = row.projection as Record<string, unknown>;
  const outPoint = (name: string) => value[name] ?? null;
  return Object.freeze({
    version: 3,
    jobId: row.jobId,
    ownerLockHash: row.ownerLockHash,
    state: row.lifecycleState,
    operation: String(value["operation"]),
    principalCapacity: String(value["principalCapacity"]),
    progress: Object.freeze({
      cycle: String(value["cycleIndex"]),
      totalCycles: String(value["totalCycles"]),
    }),
    cells: Object.freeze({
      job: outPoint("jobOutPoint"),
      daoVault: outPoint("vaultOutPoint"),
      compensation: outPoint("compensationOutPoint"),
    }),
    prepareCredit: value["prepareCredit"] ?? null,
    terminalOwnerControl: value["terminalOwnerControl"] === true,
    evidence: Object.freeze({
      canonical: true as const,
      blockNumber: row.observedBlockNumber,
      blockHash: row.observedBlockHash,
      transactionHash: row.observedTransactionHash,
    }),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export class DaoHarvestV3ReadService {
  readonly #database: AutomataDatabase;
  readonly #network: string;
  constructor(database: AutomataDatabase, network: string) {
    this.#database = database;
    this.#network = network;
  }
  async get(jobIdValue: string) {
    const jobId = hash(jobIdValue, "jobId");
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
    if (!row) throw new NotFoundException("DAO Harvest V3 automation was not found");
    return rowModel(row);
  }
  async list(ownerValue?: string, cursorValue?: string, limitValue?: string) {
    const owner = ownerValue === undefined ? undefined : hash(ownerValue, "owner");
    const cursor = cursorValue === undefined ? undefined : hash(cursorValue, "cursor");
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException("limit must be between 1 and 100");
    const filters = [
      eq(daoHarvestV3Jobs.networkId, this.#network),
      eq(daoHarvestV3Jobs.canonical, true),
      ...(owner ? [eq(daoHarvestV3Jobs.ownerLockHash, owner)] : []),
      ...(cursor ? [lt(daoHarvestV3Jobs.jobId, cursor)] : []),
    ];
    const rows = await this.#database
      .select()
      .from(daoHarvestV3Jobs)
      .where(and(...filters))
      .orderBy(desc(daoHarvestV3Jobs.jobId))
      .limit(limit + 1);
    return Object.freeze({
      items: Object.freeze(rows.slice(0, limit).map(rowModel)),
      page: Object.freeze({
        limit,
        nextCursor: rows.length > limit ? rows[limit - 1]!.jobId : null,
      }),
    });
  }
}

export class DaoHarvestV3MutationService {
  readonly #adapter: DaoHarvestV3MutationAdapter | undefined;
  readonly #setupEnabled: boolean;
  constructor(adapter?: DaoHarvestV3MutationAdapter, setupEnabled = false) {
    this.#adapter = adapter;
    this.#setupEnabled = setupEnabled;
  }
  build(operation: DaoHarvestV3BuildOperation, body: unknown) {
    if (!this.#adapter)
      throw new ServiceUnavailableException("DAO Harvest V3 is not deployed on this API");
    if (operation === "setup" && !this.#setupEnabled)
      throw new ServiceUnavailableException("New DAO Harvest V3 setup is disabled");
    return this.#adapter.build(operation, body);
  }
}

export class DaoHarvestV3Controller {
  readonly #reads: DaoHarvestV3ReadService;
  readonly #mutations: DaoHarvestV3MutationService;
  constructor(reads: DaoHarvestV3ReadService, mutations: DaoHarvestV3MutationService) {
    this.#reads = reads;
    this.#mutations = mutations;
  }
  list(query: { readonly owner?: string; readonly cursor?: string; readonly limit?: string }) {
    return this.#reads.list(query.owner, query.cursor, query.limit);
  }
  get(jobId: string) {
    return this.#reads.get(jobId);
  }
  build(operationValue: string, body: unknown) {
    if (!OPERATIONS.includes(operationValue as DaoHarvestV3BuildOperation))
      throw new BadRequestException("unsupported DAO Harvest V3 operation");
    return this.#mutations.build(operationValue as DaoHarvestV3BuildOperation, body);
  }
}

Injectable()(DaoHarvestV3ReadService);
Injectable()(DaoHarvestV3MutationService);
Inject(DaoHarvestV3ReadService)(DaoHarvestV3Controller, undefined, 0);
Inject(DaoHarvestV3MutationService)(DaoHarvestV3Controller, undefined, 1);
Controller("v1/dao-harvest-v3")(DaoHarvestV3Controller);
ApiTags("DAO Harvest V3")(DaoHarvestV3Controller);

const listDescriptor = Object.getOwnPropertyDescriptor(DaoHarvestV3Controller.prototype, "list")!;
Get()(DaoHarvestV3Controller.prototype, "list", listDescriptor);
Query()(DaoHarvestV3Controller.prototype, "list", 0);
ApiOperation({ summary: "List canonical DAO Harvest V3 automations" })(
  DaoHarvestV3Controller.prototype,
  "list",
  listDescriptor,
);
for (const name of ["owner", "cursor", "limit"] as const)
  ApiQuery({ name, required: false })(DaoHarvestV3Controller.prototype, "list", listDescriptor);
ApiOkResponse({ schema: { type: "object" } })(
  DaoHarvestV3Controller.prototype,
  "list",
  listDescriptor,
);

const getDescriptor = Object.getOwnPropertyDescriptor(DaoHarvestV3Controller.prototype, "get")!;
Get(":jobId")(DaoHarvestV3Controller.prototype, "get", getDescriptor);
Param("jobId")(DaoHarvestV3Controller.prototype, "get", 0);
ApiOperation({ summary: "Read one canonical DAO Harvest V3 automation" })(
  DaoHarvestV3Controller.prototype,
  "get",
  getDescriptor,
);
ApiParam({ name: "jobId" })(DaoHarvestV3Controller.prototype, "get", getDescriptor);
ApiOkResponse({ schema: { type: "object" } })(
  DaoHarvestV3Controller.prototype,
  "get",
  getDescriptor,
);

const buildDescriptor = Object.getOwnPropertyDescriptor(DaoHarvestV3Controller.prototype, "build")!;
Post("build/:operation")(DaoHarvestV3Controller.prototype, "build", buildDescriptor);
Param("operation")(DaoHarvestV3Controller.prototype, "build", 0);
Body()(DaoHarvestV3Controller.prototype, "build", 1);
ApiOperation({ summary: "Build a reviewed DAO Harvest V3 transaction" })(
  DaoHarvestV3Controller.prototype,
  "build",
  buildDescriptor,
);
ApiParam({ name: "operation", enum: OPERATIONS })(
  DaoHarvestV3Controller.prototype,
  "build",
  buildDescriptor,
);
ApiBody({ schema: { type: "object" } })(DaoHarvestV3Controller.prototype, "build", buildDescriptor);
ApiOkResponse({ schema: { type: "object" } })(
  DaoHarvestV3Controller.prototype,
  "build",
  buildDescriptor,
);
