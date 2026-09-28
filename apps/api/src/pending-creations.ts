import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Post,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { and, desc, eq, inArray } from "drizzle-orm";

import { parseHash32 } from "@ckb-automata/core";

import type { AutomataDatabase } from "./database/client.ts";
import { transactionAttempts } from "./database/schema.ts";
import { TransactionBuildService, type PendingCreationMetadata } from "./transactions.ts";
import {
  TransactionProgressService,
  type TransactionProgress,
  type TransactionProgressState,
} from "./transaction-progress.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ACTIVE_STATES = ["submitted", "proposed", "committed", "confirmed"] as const;

export interface PendingCreationReadModel extends PendingCreationMetadata {
  readonly confirmations: string;
  readonly requiredConfirmations: number;
  readonly status: "confirming" | "submitting" | "waiting";
  readonly submittedAt: string;
  readonly transactionHash: string;
}

interface StoredPendingCreation extends PendingCreationMetadata {
  readonly kind: "pending_creation";
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException({
      status: "invalid_request",
      code: "INVALID_CREATION_SUBMISSION",
      message: "creation submission must be an object",
    });
  }
  return value as Record<string, unknown>;
}

function transactionHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new BadRequestException({
      status: "invalid_request",
      code: "INVALID_CREATION_SUBMISSION",
      message: "transactionHash must be a lowercase 0x-prefixed 32-byte hash",
    });
  }
  return value;
}

function stored(metadata: PendingCreationMetadata): StoredPendingCreation {
  return Object.freeze({ kind: "pending_creation", ...metadata });
}

function parseStored(value: unknown): StoredPendingCreation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const amount = item["recipientAmount"] as Record<string, unknown> | undefined;
  if (
    item["kind"] !== "pending_creation" ||
    typeof item["jobId"] !== "string" ||
    typeof item["notBefore"] !== "string" ||
    typeof item["ownerLockHash"] !== "string" ||
    typeof item["remainingRuns"] !== "string" ||
    (item["template"] !== "deadline" && item["template"] !== "recurring") ||
    typeof amount?.["perExecution"] !== "string" ||
    typeof amount["total"] !== "string"
  ) {
    return undefined;
  }
  return item as unknown as StoredPendingCreation;
}

function displayStatus(state: TransactionProgressState): PendingCreationReadModel["status"] {
  if (state === "submitted") return "submitting";
  if (state === "confirmed") return "waiting";
  return "confirming";
}

export class PendingCreationService {
  readonly #database: AutomataDatabase;
  readonly #network: string;
  readonly #progress: TransactionProgressService;
  readonly #transactions: TransactionBuildService;

  constructor(
    database: AutomataDatabase,
    network: string,
    transactions: TransactionBuildService,
    progress: TransactionProgressService,
  ) {
    this.#database = database;
    this.#network = network;
    this.#transactions = transactions;
    this.#progress = progress;
  }

  async register(input: unknown): Promise<PendingCreationReadModel> {
    const body = record(input);
    const supported = new Set([
      "operation",
      "request",
      "intentHash",
      "policyCriticalHash",
      "reviewContext",
      "transaction",
      "transactionHash",
    ]);
    if (Object.keys(body).some((key) => !supported.has(key))) {
      throw new BadRequestException({
        status: "invalid_request",
        code: "INVALID_CREATION_SUBMISSION",
        message: "creation submission contains unsupported fields",
      });
    }
    const hash = transactionHash(body["transactionHash"]);
    const validationBody = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "transactionHash"),
    );
    await this.#transactions.validateSubmitted(validationBody, hash);
    const metadata = await this.#transactions.creationMetadata(body["operation"], body["request"]);
    const submittedAt = new Date();
    await this.#database
      .insert(transactionAttempts)
      .values({
        id: randomUUID(),
        networkId: this.#network,
        operation: "create",
        simulation: stored(metadata),
        state: "submitted",
        submittedAt,
        txHash: hash,
      })
      .onConflictDoNothing();
    return Object.freeze({
      ...metadata,
      confirmations: "0",
      requiredConfirmations: 1,
      status: "submitting",
      submittedAt: submittedAt.toISOString(),
      transactionHash: hash,
    });
  }

  async list(input: {
    readonly indexedJobIds: ReadonlySet<string>;
    readonly ownerLockHash?: string;
    readonly state?: string;
    readonly template?: string;
  }): Promise<readonly PendingCreationReadModel[]> {
    if (input.state !== undefined && input.state !== "live") return Object.freeze([]);
    const rows = await this.#database
      .select()
      .from(transactionAttempts)
      .where(
        and(
          eq(transactionAttempts.networkId, this.#network),
          eq(transactionAttempts.operation, "create"),
          inArray(transactionAttempts.state, [...ACTIVE_STATES]),
        ),
      )
      .orderBy(desc(transactionAttempts.submittedAt));
    const items: PendingCreationReadModel[] = [];
    for (const row of rows) {
      const metadata = parseStored(row.simulation);
      if (
        metadata === undefined ||
        row.txHash === null ||
        row.submittedAt === null ||
        input.indexedJobIds.has(metadata.jobId) ||
        (input.ownerLockHash !== undefined && metadata.ownerLockHash !== input.ownerLockHash) ||
        (input.template !== undefined && metadata.template !== input.template)
      ) {
        continue;
      }
      let progress: TransactionProgress;
      try {
        progress = await this.#progress.read(row.txHash, {
          submittedAt: row.submittedAt.toISOString(),
        });
      } catch {
        progress = {
          block: null,
          confirmations: "0",
          observedAt: new Date().toISOString(),
          reason: null,
          requiredConfirmations: 1,
          state: row.state as TransactionProgressState,
          transactionHash: parseHash32(row.txHash),
        };
      }
      if (!ACTIVE_STATES.includes(progress.state as (typeof ACTIVE_STATES)[number])) {
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
      items.push(
        Object.freeze({
          ...metadata,
          confirmations: progress.confirmations,
          requiredConfirmations: progress.requiredConfirmations,
          status: displayStatus(progress.state),
          submittedAt: row.submittedAt.toISOString(),
          transactionHash: row.txHash,
        }),
      );
    }
    return Object.freeze(items);
  }
}

export class PendingCreationController {
  readonly #pending: PendingCreationService;

  constructor(pending: PendingCreationService) {
    this.#pending = pending;
  }

  register(body: unknown): Promise<PendingCreationReadModel> {
    return this.#pending.register(body);
  }
}

Injectable()(PendingCreationService);
Inject(PendingCreationService)(PendingCreationController, undefined, 0);
Controller("transactions")(PendingCreationController);
ApiTags("transactions")(PendingCreationController);
const registerDescriptor = Object.getOwnPropertyDescriptor(
  PendingCreationController.prototype,
  "register",
)!;
Post("register-creation")(PendingCreationController.prototype, "register", registerDescriptor);
HttpCode(200)(PendingCreationController.prototype, "register", registerDescriptor);
Body()(PendingCreationController.prototype, "register", 0);
ApiOperation({ summary: "Register a submitted creation while it confirms" })(
  PendingCreationController.prototype,
  "register",
  registerDescriptor,
);
ApiBody({
  schema: {
    type: "object",
    required: [
      "operation",
      "request",
      "intentHash",
      "policyCriticalHash",
      "reviewContext",
      "transaction",
      "transactionHash",
    ],
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: ["create_deadline_job", "create_recurring_job"],
      },
      request: { type: "object" },
      intentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      policyCriticalHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      reviewContext: { type: "object" },
      transaction: { type: "object" },
      transactionHash: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
    },
  },
})(PendingCreationController.prototype, "register", registerDescriptor);
ApiOkResponse({
  schema: {
    type: "object",
    required: [
      "jobId",
      "notBefore",
      "ownerLockHash",
      "recipientAmount",
      "remainingRuns",
      "template",
      "confirmations",
      "requiredConfirmations",
      "status",
      "submittedAt",
      "transactionHash",
    ],
    properties: {
      jobId: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
      notBefore: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
      ownerLockHash: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
      recipientAmount: {
        type: "object",
        required: ["perExecution", "total"],
        properties: {
          perExecution: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
          total: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        },
      },
      remainingRuns: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
      template: { type: "string", enum: ["deadline", "recurring"] },
      confirmations: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
      requiredConfirmations: { type: "integer", minimum: 1 },
      status: { type: "string", enum: ["submitting", "confirming", "waiting"] },
      submittedAt: { type: "string", format: "date-time" },
      transactionHash: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
    },
  },
})(PendingCreationController.prototype, "register", registerDescriptor);
ApiBadRequestResponse({ description: "Malformed or invalid creation submission" })(
  PendingCreationController.prototype,
  "register",
  registerDescriptor,
);
