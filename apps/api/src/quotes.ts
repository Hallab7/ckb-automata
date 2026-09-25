import { createHash } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { WitnessArgs, type ClientTransactionResponse } from "@ckb-ccc/shell";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";
import { and, eq, lte } from "drizzle-orm";

import {
  CONTRACT_CAPACITY,
  REVIEW_FEE_RATE_MAXIMUM,
  REVIEW_TRANSACTION_MAXIMUM_BYTES,
  calculateDeadlineQuote,
  calculateRecurringQuote,
  deriveDeadlinePayloadHash,
  deriveRecurringPayloadHash,
  hash32FromBytes,
  hash32ToBytes,
  inspectJobData,
  parseHash32,
} from "@ckb-automata/core";
import { CampaignDataV1, RecurringPayloadV1 } from "@ckb-automata/molecule";

import type { CkbReadClient } from "./ckb-client.ts";
import type { AutomataDatabase } from "./database/client.ts";
import { indexerCheckpoints, jobs } from "./database/schema.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const MAX_LINEAGE_DEPTH = 128;
const TARGET_BLOCK_SECONDS = 10n;

export const JOB_QUOTE_ASSUMPTIONS = Object.freeze({
  deadline: Object.freeze({
    transactionBytes: Object.freeze({
      minimum: "700",
      maximum: REVIEW_TRANSACTION_MAXIMUM_BYTES.toString(),
    }),
    feeRatePerKilobyte: Object.freeze({
      minimum: "1000",
      maximum: REVIEW_FEE_RATE_MAXIMUM.toString(),
    }),
  }),
  recurring: Object.freeze({
    transactionBytes: Object.freeze({
      minimum: "500",
      maximum: REVIEW_TRANSACTION_MAXIMUM_BYTES.toString(),
    }),
    feeRatePerKilobyte: Object.freeze({
      minimum: "1000",
      maximum: REVIEW_FEE_RATE_MAXIMUM.toString(),
    }),
  }),
});

export type QuoteChainClient = Pick<CkbReadClient, "getTipHeader" | "getTransactionStatus">;

export interface JobQuote {
  readonly quoteId: string;
  readonly jobId: string;
  readonly network: string;
  readonly template: "deadline" | "recurring";
  readonly amounts: {
    readonly occupiedCapacity: {
      readonly jobCell: string;
      readonly applicationCell: string;
      readonly total: string;
    };
    readonly payout: { readonly perExecution: string; readonly total: string };
    readonly rewards: { readonly perExecution: string; readonly total: string };
    readonly remainingBudget: string;
    readonly residualRefund: string;
    readonly retainedTerminalCapacity: string;
    readonly currentLockedTotal: string;
    readonly estimatedFee: { readonly minimum: string; readonly maximum: string };
  };
  readonly schedule: {
    readonly executionsRemaining: string;
    readonly earliestBlock: string;
    readonly latestBlock: string | null;
    readonly blocksUntilEligible: string;
    readonly approximateSecondsUntilEligible: string;
    readonly estimateBasis: "ckb_target_block_interval";
  };
  readonly snapshot: {
    readonly tip: { readonly blockNumber: string; readonly blockHash: string };
    readonly indexCheckpoint: { readonly blockNumber: string; readonly blockHash: string };
    readonly jobOutPoint: { readonly txHash: string; readonly index: string };
    readonly jobDataHash: string;
  };
  readonly expiry: {
    readonly afterBlock: string;
    readonly condition: "tip_or_job_snapshot_change";
  };
  readonly assumptions: (typeof JOB_QUOTE_ASSUMPTIONS)[keyof typeof JOB_QUOTE_ASSUMPTIONS];
}

type JobRow = typeof jobs.$inferSelect;

interface QuoteEvidence {
  readonly payoutPerExecution: bigint;
  readonly applicationCellCapacity: bigint;
}

function parseJobId(value: string): string {
  if (!HASH_PATTERN.test(value)) {
    throw new BadRequestException({
      status: "invalid_request",
      code: "INVALID_HASH",
      message: "jobId must be a lowercase 0x-prefixed 32-byte hash",
    });
  }
  return value;
}

function hexBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value)) throw new Error("chain bytes are not canonical");
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function dataHex(value: Buffer): `0x${string}` {
  return `0x${value.toString("hex")}`;
}

function hashData(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceTransactionMatches(row: JobRow, response: ClientTransactionResponse): boolean {
  if (response.status !== "committed" || response.blockHash !== row.blockHash) return false;
  const index = BigInt(row.outpointIndex);
  if (index > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const output = response.transaction.outputs[Number(index)];
  return (
    output !== undefined &&
    BigInt(output.capacity) === BigInt(row.capacity) &&
    response.transaction.outputsData[Number(index)] === dataHex(row.data)
  );
}

async function resolveEvidence(
  row: JobRow,
  client: QuoteChainClient,
  inspection: Extract<ReturnType<typeof inspectJobData>, { status: "ok" }>,
): Promise<QuoteEvidence> {
  const seen = new Set<string>();
  let txHash = row.outpointTxHash;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
    if (seen.has(txHash)) throw new Error("job transaction lineage contains a cycle");
    seen.add(txHash);
    const response = await client.getTransactionStatus(txHash);
    if (!response || response.status !== "committed") {
      throw new Error("job transaction lineage is not committed");
    }
    if (depth === 0 && !sourceTransactionMatches(row, response)) {
      throw new Error("indexed job outpoint does not match committed chain evidence");
    }
    const evidence =
      row.policyKind === "recurring"
        ? recurringEvidence([response], inspection.job.payloadHash, inspection.job.policyScriptHash)
        : row.policyKind === "deadline"
          ? deadlineEvidence(
              [response],
              inspection.job.payloadHash,
              inspection.job.policyScriptHash,
              inspection.job.notBefore,
            )
          : undefined;
    if (evidence !== undefined) return evidence;
    const previous = response.transaction.inputs[0]?.previousOutput.txHash;
    if (previous === undefined || previous === `0x${"0".repeat(64)}`) {
      throw new Error("quote evidence is unavailable in the job lineage");
    }
    txHash = previous;
  }
  throw new Error("job transaction lineage exceeds the supported depth");
}

function recurringEvidence(
  lineage: readonly ClientTransactionResponse[],
  payloadHash: string,
  policyScriptHash: string,
): QuoteEvidence | undefined {
  const matches = new Map<string, ReturnType<typeof RecurringPayloadV1.unpack>>();
  for (const response of lineage) {
    for (const witness of response.transaction.witnesses) {
      try {
        const outputType = WitnessArgs.fromBytes(witness).outputType;
        if (!outputType) continue;
        const bytes = hexBytes(outputType);
        if (
          hash32FromBytes(
            deriveRecurringPayloadHash(hash32ToBytes(parseHash32(policyScriptHash)), bytes),
          ) !== payloadHash
        ) {
          continue;
        }
        matches.set(outputType, RecurringPayloadV1.unpack(bytes));
      } catch {
        // Non-Job witnesses are irrelevant to payload recovery.
      }
    }
  }
  if (matches.size === 0) return undefined;
  if (matches.size > 1) throw new Error("recurring payload evidence is ambiguous");
  const payload = [...matches.values()][0]!;
  return Object.freeze({
    payoutPerExecution: BigInt(payload.amount.toString()),
    applicationCellCapacity: 0n,
  });
}

function deadlineEvidence(
  lineage: readonly ClientTransactionResponse[],
  payloadHash: string,
  policyScriptHash: string,
  earliestBlock: bigint,
): QuoteEvidence | undefined {
  const matches: { pledged: bigint; capacity: bigint }[] = [];
  for (const response of lineage) {
    for (const [index, output] of response.transaction.outputs.entries()) {
      const type = output.type;
      const data = response.transaction.outputsData[index];
      if (!type || !data) continue;
      try {
        const campaignTypeHash = parseHash32(scriptToHash(type));
        if (
          hash32FromBytes(
            deriveDeadlinePayloadHash(parseHash32(policyScriptHash), campaignTypeHash),
          ) !== payloadHash
        ) {
          continue;
        }
        const campaign = CampaignDataV1.unpack(hexBytes(data));
        if (BigInt(campaign.deadline_since.toString()) !== earliestBlock) continue;
        matches.push({
          pledged: BigInt(campaign.pledged.toString()),
          capacity: BigInt(output.capacity),
        });
      } catch {
        // Outputs unrelated to the committed campaign are ignored.
      }
    }
  }
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new Error("deadline campaign evidence is ambiguous");
  return Object.freeze({
    payoutPerExecution: matches[0]!.pledged,
    applicationCellCapacity: matches[0]!.capacity,
  });
}

function quoteBody(
  row: JobRow,
  checkpoint: { readonly blockNumber: string; readonly blockHash: string },
  tip: { readonly number: bigint; readonly hash: string },
  evidence: QuoteEvidence,
): Omit<JobQuote, "quoteId"> {
  const inspected = inspectJobData(row.data);
  if (inspected.status !== "ok") throw new Error("indexed job data is not decodable");
  const checkpointNumber = BigInt(checkpoint.blockNumber);
  if (
    tip.number < checkpointNumber ||
    (tip.number === checkpointNumber && tip.hash !== checkpoint.blockHash)
  ) {
    throw new Error("index checkpoint is not consistent with the chain tip");
  }
  const job = inspected.job;
  const template = row.policyKind;
  if (template !== "deadline" && template !== "recurring") {
    throw new Error("indexed job has an unsupported quote template");
  }
  const assumptions = JOB_QUOTE_ASSUMPTIONS[template];
  const sdkQuote =
    template === "recurring"
      ? calculateRecurringQuote({
          amountPerExecution: evidence.payoutPerExecution,
          rewardPerExecution: job.reward,
          executions: job.remainingRuns,
          creationFee: assumptions,
        })
      : calculateDeadlineQuote({
          pledgedAmount: evidence.payoutPerExecution,
          reward: job.reward,
          creationFee: assumptions,
        });

  const requiredApplication = evidence.payoutPerExecution * job.remainingRuns;
  const requiredRewards = job.reward * job.remainingRuns;
  const jobControlledSpend =
    template === "recurring" ? requiredApplication + requiredRewards : requiredRewards;
  const currentJobCapacity = BigInt(row.capacity);
  if (
    job.remainingBudget < jobControlledSpend ||
    currentJobCapacity !== CONTRACT_CAPACITY.jobCellV1 + job.remainingBudget
  ) {
    throw new Error(
      `indexed job funding is inconsistent with its committed schedule: budget=${job.remainingBudget}, spend=${jobControlledSpend}, capacity=${currentJobCapacity}`,
    );
  }
  if (
    template === "deadline" &&
    evidence.applicationCellCapacity !==
      CONTRACT_CAPACITY.campaignCellV1 + evidence.payoutPerExecution
  ) {
    throw new Error("deadline campaign capacity is inconsistent with its committed payout");
  }
  const residualRefund = currentJobCapacity - jobControlledSpend;
  const blocksUntilEligible = job.notBefore > tip.number ? job.notBefore - tip.number : 0n;
  const currentLockedTotal = currentJobCapacity + evidence.applicationCellCapacity;

  return Object.freeze({
    jobId: row.jobId,
    network: row.networkId,
    template,
    amounts: Object.freeze({
      occupiedCapacity: Object.freeze({
        jobCell: sdkQuote.occupiedCapacity.jobCell.toString(),
        applicationCell: sdkQuote.occupiedCapacity.applicationCell.toString(),
        total: sdkQuote.occupiedCapacity.total.toString(),
      }),
      payout: Object.freeze({
        perExecution: evidence.payoutPerExecution.toString(),
        total: requiredApplication.toString(),
      }),
      rewards: Object.freeze({
        perExecution: job.reward.toString(),
        total: requiredRewards.toString(),
      }),
      remainingBudget: job.remainingBudget.toString(),
      residualRefund: residualRefund.toString(),
      retainedTerminalCapacity: sdkQuote.retainedTerminalCapacity.toString(),
      currentLockedTotal: currentLockedTotal.toString(),
      estimatedFee: Object.freeze({
        minimum: sdkQuote.estimatedFee.minimum.toString(),
        maximum: sdkQuote.estimatedFee.maximum.toString(),
      }),
    }),
    schedule: Object.freeze({
      executionsRemaining: job.remainingRuns.toString(),
      earliestBlock: job.notBefore.toString(),
      latestBlock: job.notAfter === 0n ? null : job.notAfter.toString(),
      blocksUntilEligible: blocksUntilEligible.toString(),
      approximateSecondsUntilEligible: (blocksUntilEligible * TARGET_BLOCK_SECONDS).toString(),
      estimateBasis: "ckb_target_block_interval" as const,
    }),
    snapshot: Object.freeze({
      tip: Object.freeze({ blockNumber: tip.number.toString(), blockHash: tip.hash }),
      indexCheckpoint: Object.freeze(checkpoint),
      jobOutPoint: Object.freeze({ txHash: row.outpointTxHash, index: row.outpointIndex }),
      jobDataHash: hashData(row.data),
    }),
    expiry: Object.freeze({
      afterBlock: tip.number.toString(),
      condition: "tip_or_job_snapshot_change" as const,
    }),
    assumptions,
  });
}

export class JobQuoteService {
  readonly #database: AutomataDatabase;
  readonly #network: string;
  readonly #chain: QuoteChainClient;

  constructor(database: AutomataDatabase, network: string, chain: QuoteChainClient) {
    this.#database = database;
    this.#network = network;
    this.#chain = chain;
  }

  async quote(jobIdInput: string): Promise<JobQuote> {
    const jobId = parseJobId(jobIdInput);
    const indexed = await this.#database.transaction(
      async (tx) => {
        const [checkpoint] = await tx
          .select({
            blockNumber: indexerCheckpoints.blockNumber,
            blockHash: indexerCheckpoints.blockHash,
          })
          .from(indexerCheckpoints)
          .where(eq(indexerCheckpoints.networkId, this.#network))
          .limit(1);
        if (checkpoint === undefined) {
          throw new ServiceUnavailableException({
            status: "unavailable",
            code: "QUOTE_SNAPSHOT_UNAVAILABLE",
          });
        }
        const [row] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.networkId, this.#network),
              eq(jobs.jobId, jobId),
              lte(jobs.blockNumber, checkpoint.blockNumber),
            ),
          )
          .limit(1);
        return { checkpoint, row };
      },
      { accessMode: "read only", isolationLevel: "repeatable read" },
    );
    if (indexed.row === undefined) {
      throw new NotFoundException({ status: "not_found", code: "JOB_NOT_FOUND" });
    }
    if (indexed.row.state !== "live") {
      throw new ConflictException({ status: "conflict", code: "JOB_NOT_LIVE" });
    }

    try {
      const inspection = inspectJobData(indexed.row.data);
      if (inspection.status !== "ok") throw new Error("indexed job data is not decodable");
      const [tip, evidence] = await Promise.all([
        this.#chain.getTipHeader(),
        resolveEvidence(indexed.row, this.#chain, inspection),
      ]);
      const body = quoteBody(indexed.row, indexed.checkpoint, tip, evidence);
      return Object.freeze({ quoteId: stableHash(body), ...body });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        { status: "unavailable", code: "QUOTE_EVIDENCE_UNAVAILABLE" },
        { cause: error },
      );
    }
  }

  async assertFresh(jobId: string, quoteId: string): Promise<JobQuote> {
    if (!/^[0-9a-f]{64}$/.test(quoteId)) {
      throw new BadRequestException({ status: "invalid_request", code: "INVALID_QUOTE_ID" });
    }
    const current = await this.quote(jobId);
    if (current.quoteId !== quoteId) {
      throw new ConflictException({
        status: "conflict",
        code: "STALE_QUOTE",
        message: "the chain or job snapshot changed; request a new quote",
      });
    }
    return current;
  }
}

export class JobQuoteController {
  readonly #quotes: JobQuoteService;

  constructor(quotes: JobQuoteService) {
    this.#quotes = quotes;
  }

  get(jobId: string): Promise<JobQuote> {
    return this.#quotes.quote(jobId);
  }
}

const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const decimalSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const decimalRangeSchema = {
  type: "object",
  required: ["minimum", "maximum"],
  properties: { minimum: decimalSchema, maximum: decimalSchema },
};

Injectable()(JobQuoteService);
Inject(JobQuoteService)(JobQuoteController, undefined, 0);
Controller("jobs")(JobQuoteController);
ApiTags("job quotes")(JobQuoteController);
Get(":jobId/quote")(
  JobQuoteController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(JobQuoteController.prototype, "get")!,
);
Param("jobId")(JobQuoteController.prototype, "get", 0);
ApiOperation({ summary: "Quote the remaining committed job schedule" })(
  JobQuoteController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(JobQuoteController.prototype, "get")!,
);
ApiParam({ name: "jobId", schema: hashSchema })(
  JobQuoteController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(JobQuoteController.prototype, "get")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: [
      "quoteId",
      "jobId",
      "network",
      "template",
      "amounts",
      "schedule",
      "snapshot",
      "expiry",
      "assumptions",
    ],
    properties: {
      quoteId: { type: "string", pattern: "^[0-9a-f]{64}$" },
      jobId: hashSchema,
      network: { type: "string" },
      template: { type: "string", enum: ["deadline", "recurring"] },
      amounts: {
        type: "object",
        required: [
          "occupiedCapacity",
          "payout",
          "rewards",
          "remainingBudget",
          "residualRefund",
          "retainedTerminalCapacity",
          "currentLockedTotal",
          "estimatedFee",
        ],
        properties: {
          remainingBudget: decimalSchema,
          residualRefund: decimalSchema,
          currentLockedTotal: decimalSchema,
          estimatedFee: decimalRangeSchema,
          occupiedCapacity: {
            type: "object",
            required: ["jobCell", "applicationCell", "total"],
            properties: {
              jobCell: decimalSchema,
              applicationCell: decimalSchema,
              total: decimalSchema,
            },
          },
          payout: {
            type: "object",
            required: ["perExecution", "total"],
            properties: { perExecution: decimalSchema, total: decimalSchema },
          },
          rewards: {
            type: "object",
            required: ["perExecution", "total"],
            properties: { perExecution: decimalSchema, total: decimalSchema },
          },
          retainedTerminalCapacity: decimalSchema,
        },
      },
      schedule: {
        type: "object",
        required: [
          "executionsRemaining",
          "earliestBlock",
          "latestBlock",
          "blocksUntilEligible",
          "approximateSecondsUntilEligible",
          "estimateBasis",
        ],
        properties: {
          executionsRemaining: decimalSchema,
          earliestBlock: decimalSchema,
          latestBlock: { ...decimalSchema, nullable: true },
          blocksUntilEligible: decimalSchema,
          approximateSecondsUntilEligible: decimalSchema,
          estimateBasis: { type: "string", enum: ["ckb_target_block_interval"] },
        },
      },
      snapshot: {
        type: "object",
        required: ["tip", "indexCheckpoint", "jobOutPoint", "jobDataHash"],
        properties: {
          tip: {
            type: "object",
            required: ["blockNumber", "blockHash"],
            properties: { blockNumber: decimalSchema, blockHash: hashSchema },
          },
          indexCheckpoint: {
            type: "object",
            required: ["blockNumber", "blockHash"],
            properties: { blockNumber: decimalSchema, blockHash: hashSchema },
          },
          jobOutPoint: {
            type: "object",
            required: ["txHash", "index"],
            properties: { txHash: hashSchema, index: decimalSchema },
          },
          jobDataHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
      expiry: {
        type: "object",
        required: ["afterBlock", "condition"],
        properties: {
          afterBlock: decimalSchema,
          condition: { type: "string", enum: ["tip_or_job_snapshot_change"] },
        },
      },
      assumptions: {
        type: "object",
        required: ["transactionBytes", "feeRatePerKilobyte"],
        properties: {
          transactionBytes: decimalRangeSchema,
          feeRatePerKilobyte: decimalRangeSchema,
        },
      },
    },
  },
})(
  JobQuoteController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(JobQuoteController.prototype, "get")!,
);
ApiBadRequestResponse({ description: "Malformed job or quote identifier" })(
  JobQuoteController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(JobQuoteController.prototype, "get")!,
);
ApiNotFoundResponse({ description: "Job not found" })(
  JobQuoteController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(JobQuoteController.prototype, "get")!,
);
ApiConflictResponse({ description: "Job is not live" })(
  JobQuoteController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(JobQuoteController.prototype, "get")!,
);
ApiServiceUnavailableResponse({ description: "Canonical quote evidence is unavailable" })(
  JobQuoteController.prototype,
  "get",
  Object.getOwnPropertyDescriptor(JobQuoteController.prototype, "get")!,
);
