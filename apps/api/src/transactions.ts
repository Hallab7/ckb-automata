import { createHash } from "node:crypto";

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";

import {
  CancellationBuildError,
  RECOVERY_REASONS,
  RecoveryBuildError,
  TopUpBuildError,
  assertCancellationCompletion,
  assertDeadlineCompletion,
  assertRecoveryCompletion,
  assertRecurringCompletion,
  assertTopUpCompletion,
  buildCancellation,
  buildDeadlineCreation,
  buildRecovery,
  buildRecurringCreation,
  buildTopUp,
  deploymentRegistry,
  parseDeadlineCreationRequest,
  parseHash32,
  parseOutPoint,
  parseRecurringCreationRequest,
  type LiveCellResolver,
  type RegisteredDeployment,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import { CkbClientError, type CkbClient } from "./ckb-client.ts";
import { JOB_QUOTE_ASSUMPTIONS, JobQuoteService, type JobQuote } from "./quotes.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const BYTE_HEX_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const NUMERIC_HEX_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export const TRANSACTION_OPERATIONS = [
  "create_deadline_job",
  "create_recurring_job",
  "cancel_job",
  "recover_job",
  "top_up_job",
] as const;

export type TransactionOperation = (typeof TRANSACTION_OPERATIONS)[number];
export type TransactionChainClient = Pick<
  CkbClient,
  "dryRun" | "getTipHeader" | "getTransactionStatus"
>;

export interface TransactionBuildResponse {
  readonly operation: TransactionOperation;
  readonly transaction: UnsignedDeadlineTransaction;
  readonly signingEntries: readonly {
    readonly role: "funding" | "owner_authorization" | "pledge";
    readonly inputIndices: readonly string[];
    readonly walletAction: "append_inputs_and_change" | "sign_existing_inputs";
  }[];
  readonly intent: unknown;
  readonly intentHash: string;
  readonly protocolIntentHash: string | null;
  readonly policyCriticalHash: string;
  readonly chainSnapshot: unknown;
  readonly quoteExpiry: unknown;
  readonly quote: unknown;
}

export interface SignedTransactionValidation {
  readonly valid: true;
  readonly operation: TransactionOperation;
  readonly intentHash: string;
  readonly policyCriticalHash: string;
  readonly dryRunCycles: string;
}

interface BuiltArtifact {
  readonly response: TransactionBuildResponse;
  readonly assertCompletion: (transaction: UnsignedDeadlineTransaction) => void;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${name} contains unsupported fields`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function hash(value: unknown, name: string): ReturnType<typeof parseHash32> {
  const parsed = text(value, name);
  if (!HASH_PATTERN.test(parsed)) throw new TypeError(`${name} must be a lowercase 32-byte hash`);
  return parseHash32(parsed);
}

function bytes(value: unknown, name: string): `0x${string}` {
  const parsed = text(value, name);
  if (!BYTE_HEX_PATTERN.test(parsed)) throw new TypeError(`${name} must be canonical byte hex`);
  return parsed as `0x${string}`;
}

function numericHex(value: unknown, name: string): `0x${string}` {
  const parsed = text(value, name);
  if (!NUMERIC_HEX_PATTERN.test(parsed)) {
    throw new TypeError(`${name} must be canonical lowercase numeric hex`);
  }
  return parsed as `0x${string}`;
}

function decimal(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!DECIMAL_PATTERN.test(parsed)) throw new TypeError(`${name} must be a canonical decimal`);
  return parsed;
}

function script(value: unknown, name: string): ScriptIdentity {
  const parsed = record(value, name);
  exact(parsed, ["codeHash", "hashType", "args"], name);
  const hashType = text(parsed["hashType"], `${name}.hashType`);
  if (hashType !== "data" && hashType !== "data1" && hashType !== "type") {
    throw new TypeError(`${name}.hashType is unsupported`);
  }
  return Object.freeze({
    codeHash: hash(parsed["codeHash"], `${name}.codeHash`),
    hashType,
    args: bytes(parsed["args"], `${name}.args`),
  });
}

function parseTransaction(value: unknown): UnsignedDeadlineTransaction {
  const parsed = record(value, "transaction");
  exact(
    parsed,
    ["version", "cellDeps", "headerDeps", "inputs", "outputs", "outputsData", "witnesses"],
    "transaction",
  );
  const version = numericHex(parsed["version"], "transaction.version");
  if (version !== "0x0") throw new TypeError("transaction.version must be 0x0");
  if (!Array.isArray(parsed["cellDeps"]))
    throw new TypeError("transaction.cellDeps must be an array");
  if (!Array.isArray(parsed["headerDeps"]))
    throw new TypeError("transaction.headerDeps must be an array");
  if (!Array.isArray(parsed["inputs"])) throw new TypeError("transaction.inputs must be an array");
  if (!Array.isArray(parsed["outputs"]))
    throw new TypeError("transaction.outputs must be an array");
  if (!Array.isArray(parsed["outputsData"]))
    throw new TypeError("transaction.outputsData must be an array");
  if (!Array.isArray(parsed["witnesses"]))
    throw new TypeError("transaction.witnesses must be an array");

  const cellDeps = parsed["cellDeps"].map((item, index) => {
    const dep = record(item, `transaction.cellDeps[${index}]`);
    exact(dep, ["outPoint", "depType"], `transaction.cellDeps[${index}]`);
    const point = record(dep["outPoint"], `transaction.cellDeps[${index}].outPoint`);
    exact(point, ["txHash", "index"], `transaction.cellDeps[${index}].outPoint`);
    const depType = text(dep["depType"], `transaction.cellDeps[${index}].depType`);
    if (depType !== "code" && depType !== "depGroup") {
      throw new TypeError(`transaction.cellDeps[${index}].depType is unsupported`);
    }
    return Object.freeze({
      outPoint: Object.freeze({
        txHash: hash(point["txHash"], `transaction.cellDeps[${index}].outPoint.txHash`),
        index: numericHex(point["index"], `transaction.cellDeps[${index}].outPoint.index`),
      }),
      depType,
    });
  });
  const inputs = parsed["inputs"].map((item, index) => {
    const input = record(item, `transaction.inputs[${index}]`);
    exact(input, ["since", "previousOutput"], `transaction.inputs[${index}]`);
    const point = record(input["previousOutput"], `transaction.inputs[${index}].previousOutput`);
    exact(point, ["txHash", "index"], `transaction.inputs[${index}].previousOutput`);
    return Object.freeze({
      since: numericHex(input["since"], `transaction.inputs[${index}].since`),
      previousOutput: Object.freeze({
        txHash: hash(point["txHash"], `transaction.inputs[${index}].previousOutput.txHash`),
        index: numericHex(point["index"], `transaction.inputs[${index}].previousOutput.index`),
      }),
    });
  });
  const outputs = parsed["outputs"].map((item, index) => {
    const output = record(item, `transaction.outputs[${index}]`);
    exact(output, ["capacity", "lock", "type"], `transaction.outputs[${index}]`);
    return Object.freeze({
      capacity: numericHex(output["capacity"], `transaction.outputs[${index}].capacity`),
      lock: script(output["lock"], `transaction.outputs[${index}].lock`),
      type:
        output["type"] === null
          ? null
          : script(output["type"], `transaction.outputs[${index}].type`),
    });
  });
  const outputsData = parsed["outputsData"].map((item, index) =>
    bytes(item, `transaction.outputsData[${index}]`),
  );
  if (outputs.length !== outputsData.length) {
    throw new TypeError("transaction outputs and outputsData lengths differ");
  }
  return Object.freeze({
    version,
    cellDeps: Object.freeze(cellDeps),
    headerDeps: Object.freeze(
      parsed["headerDeps"].map((item, index) => hash(item, `transaction.headerDeps[${index}]`)),
    ),
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    outputsData: Object.freeze(outputsData),
    witnesses: Object.freeze(
      parsed["witnesses"].map((item, index) => bytes(item, `transaction.witnesses[${index}]`)),
    ),
  });
}

function normalized(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, normalized(item)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex");
}

function dataHash(value: string): string {
  return createHash("sha256")
    .update(Buffer.from(value.slice(2), "hex"))
    .digest("hex");
}

function quoteAmounts(quote: {
  readonly occupiedCapacity: {
    readonly jobCell: bigint;
    readonly applicationCell: bigint;
    readonly total: bigint;
  };
  readonly applicationAmount: { readonly perExecution: bigint; readonly total: bigint };
  readonly rewards: { readonly perExecution: bigint; readonly total: bigint };
  readonly remainingBudget: bigint;
  readonly residualRefund: bigint;
  readonly retainedTerminalCapacity: bigint;
  readonly estimatedFee: { readonly minimum: bigint; readonly maximum: bigint };
  readonly maximumLockedTotal: bigint;
  readonly maximumOwnerFunding: bigint;
}): unknown {
  return normalized(quote);
}

function creationSigningEntries(operation: TransactionOperation, pledgeCount = 0) {
  const entries: TransactionBuildResponse["signingEntries"][number][] = [];
  if (operation === "create_deadline_job") {
    entries.push({
      role: "pledge",
      inputIndices: Array.from({ length: pledgeCount }, (_, index) => index.toString()),
      walletAction: "sign_existing_inputs",
    });
  }
  entries.push({
    role: "funding",
    inputIndices: [],
    walletAction: "append_inputs_and_change",
  });
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

const ownerSigningEntries = Object.freeze([
  Object.freeze({
    role: "owner_authorization" as const,
    inputIndices: Object.freeze([] as string[]),
    walletAction: "append_inputs_and_change" as const,
  }),
]);

function envelope(input: {
  operation: TransactionOperation;
  transaction: UnsignedDeadlineTransaction;
  signingEntries: TransactionBuildResponse["signingEntries"];
  intent: unknown;
  protocolIntentHash?: string;
  chainSnapshot: unknown;
  quoteExpiry: unknown;
  quote: unknown;
}): TransactionBuildResponse {
  const intent = normalized(input.intent);
  const quote = normalized(input.quote);
  const intentHash = digest({ operation: input.operation, intent });
  const critical = Object.freeze({
    operation: input.operation,
    intentHash,
    quote,
    chainSnapshot: normalized(input.chainSnapshot),
    quoteExpiry: normalized(input.quoteExpiry),
    transaction: input.transaction,
  });
  return Object.freeze({
    operation: input.operation,
    transaction: input.transaction,
    signingEntries: input.signingEntries,
    intent,
    intentHash,
    protocolIntentHash: input.protocolIntentHash ?? null,
    policyCriticalHash: digest(critical),
    chainSnapshot: normalized(input.chainSnapshot),
    quoteExpiry: normalized(input.quoteExpiry),
    quote,
  });
}

function parseOperation(value: unknown): TransactionOperation {
  const operation = text(value, "operation");
  if (!TRANSACTION_OPERATIONS.includes(operation as TransactionOperation)) {
    throw new TypeError("operation is unsupported");
  }
  return operation as TransactionOperation;
}

function creationSnapshot(
  tip: { readonly number: bigint; readonly hash: string },
  deployment: RegisteredDeployment,
) {
  return Object.freeze({
    tip: Object.freeze({ blockNumber: tip.number.toString(), blockHash: tip.hash }),
    deploymentManifestSha256: deployment.manifestSha256,
  });
}

export class TransactionBuildService {
  readonly #quotes: JobQuoteService;
  readonly #chain: TransactionChainClient;
  readonly #genesisHash: string;
  #deployment: Promise<RegisteredDeployment> | undefined;

  constructor(quotes: JobQuoteService, chain: TransactionChainClient, genesisHash: string) {
    this.#quotes = quotes;
    this.#chain = chain;
    this.#genesisHash = genesisHash;
  }

  #loadDeployment(): Promise<RegisteredDeployment> {
    this.#deployment ??= deploymentRegistry.load(this.#genesisHash).then((result) => {
      if (result.status !== "ok") {
        throw new ServiceUnavailableException({
          status: "unavailable",
          code: "DEPLOYMENT_UNAVAILABLE",
        });
      }
      return result.deployment;
    });
    return this.#deployment;
  }

  async construct(
    operation: TransactionOperation,
    input: unknown,
  ): Promise<TransactionBuildResponse> {
    try {
      return (await this.#artifact(operation, input)).response;
    } catch (error) {
      return this.#mapBuildError(error);
    }
  }

  async validate(input: unknown): Promise<SignedTransactionValidation> {
    let request: Record<string, unknown>;
    let operation: TransactionOperation;
    let artifact: BuiltArtifact;
    try {
      request = record(input, "validation request");
      exact(
        request,
        ["operation", "request", "intentHash", "policyCriticalHash", "transaction"],
        "validation request",
      );
      operation = parseOperation(request["operation"]);
      artifact = await this.#artifact(operation, request["request"]);
    } catch (error) {
      return this.#mapBuildError(error);
    }
    let reviewedIntentHash: string;
    try {
      reviewedIntentHash = text(request["intentHash"], "intentHash");
      if (!/^[0-9a-f]{64}$/.test(reviewedIntentHash)) {
        throw new TypeError("intentHash must be a lowercase SHA-256 digest");
      }
    } catch (error) {
      return this.#mapBuildError(error);
    }
    if (reviewedIntentHash !== artifact.response.intentHash) {
      throw new ConflictException({
        status: "conflict",
        code: "STALE_TRANSACTION_INTENT",
        message: "the quote or chain snapshot changed; review a newly built transaction",
      });
    }
    let reviewedPolicyHash: string;
    try {
      reviewedPolicyHash = text(request["policyCriticalHash"], "policyCriticalHash");
      if (!/^[0-9a-f]{64}$/.test(reviewedPolicyHash)) {
        throw new TypeError("policyCriticalHash must be a lowercase SHA-256 digest");
      }
    } catch (error) {
      return this.#mapBuildError(error);
    }
    if (reviewedPolicyHash !== artifact.response.policyCriticalHash) {
      throw new ConflictException({
        status: "conflict",
        code: "STALE_POLICY_CONTEXT",
        message: "the quote or chain snapshot changed; review a newly built transaction",
      });
    }

    let transaction: UnsignedDeadlineTransaction;
    try {
      transaction = parseTransaction(request["transaction"]);
      artifact.assertCompletion(transaction);
    } catch (error) {
      throw new BadRequestException({
        status: "invalid_request",
        code: "SIGNED_TRANSACTION_MISMATCH",
        message: error instanceof Error ? error.message : "signed transaction is invalid",
      });
    }

    let cycles: bigint;
    try {
      cycles = await this.#chain.dryRun(transaction as never);
    } catch (error) {
      throw new UnprocessableEntityException(
        { status: "invalid_transaction", code: "DRY_RUN_FAILED" },
        { cause: error },
      );
    }
    return Object.freeze({
      valid: true,
      operation,
      intentHash: artifact.response.intentHash,
      policyCriticalHash: artifact.response.policyCriticalHash,
      dryRunCycles: cycles.toString(),
    });
  }

  async #artifact(operation: TransactionOperation, input: unknown): Promise<BuiltArtifact> {
    const deployment = await this.#loadDeployment();
    if (operation === "create_deadline_job") return this.#deadline(input, deployment);
    if (operation === "create_recurring_job") return this.#recurring(input, deployment);
    return this.#ownerAction(operation, input, deployment);
  }

  async #deadline(input: unknown, deployment: RegisteredDeployment): Promise<BuiltArtifact> {
    const request = parseDeadlineCreationRequest(input);
    const build = buildDeadlineCreation({
      deployment,
      pledges: request.pledges,
      target: request.target,
      deadlineBlock: request.deadlineBlock,
      successLockHash: request.successLockHash,
      cancelLockHash: request.cancelLockHash,
      reward: request.reward,
      creatorNonce: request.creatorNonce,
      creationFee: JOB_QUOTE_ASSUMPTIONS.deadline,
    });
    const tip = await this.#chain.getTipHeader();
    const response = envelope({
      operation: "create_deadline_job",
      transaction: build.transaction,
      signingEntries: creationSigningEntries("create_deadline_job", request.pledges.length),
      intent: build.intent,
      protocolIntentHash: build.intentHash,
      chainSnapshot: creationSnapshot(tip, deployment),
      quoteExpiry: { afterBlock: tip.number.toString(), condition: "tip_change_before_signing" },
      quote: quoteAmounts(build.quote),
    });
    return Object.freeze({
      response,
      assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
        assertDeadlineCompletion(build, transaction),
    });
  }

  async #recurring(input: unknown, deployment: RegisteredDeployment): Promise<BuiltArtifact> {
    const request = parseRecurringCreationRequest(input);
    const build = buildRecurringCreation({
      deployment,
      ownerLockHash: request.ownerLockHash,
      recipientLockHash: request.recipientLockHash,
      amount: request.amount,
      intervalBlocks: request.intervalBlocks,
      firstNotBefore: request.firstNotBefore,
      totalRuns: request.totalRuns,
      reward: request.reward,
      creatorNonce: request.creatorNonce,
      creationFee: JOB_QUOTE_ASSUMPTIONS.recurring,
    });
    const tip = await this.#chain.getTipHeader();
    const response = envelope({
      operation: "create_recurring_job",
      transaction: build.transaction,
      signingEntries: creationSigningEntries("create_recurring_job"),
      intent: build.intent,
      protocolIntentHash: build.intentHash,
      chainSnapshot: creationSnapshot(tip, deployment),
      quoteExpiry: { afterBlock: tip.number.toString(), condition: "tip_change_before_signing" },
      quote: quoteAmounts(build.quote),
    });
    return Object.freeze({
      response,
      assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
        assertRecurringCompletion(build, transaction),
    });
  }

  async #ownerAction(
    operation: Exclude<TransactionOperation, "create_deadline_job" | "create_recurring_job">,
    input: unknown,
    deployment: RegisteredDeployment,
  ): Promise<BuiltArtifact> {
    const request = record(input, "owner action request");
    const extra =
      operation === "recover_job"
        ? ["reason"]
        : operation === "top_up_job"
          ? ["rewardIncrease", "budgetIncrease", "capacityIncrease"]
          : [];
    exact(request, ["jobId", "quoteId", "ownerLock", ...extra], "owner action request");
    const jobId = hash(request["jobId"], "jobId");
    const quoteId = text(request["quoteId"], "quoteId");
    const ownerLock = script(request["ownerLock"], "ownerLock");
    const quote = await this.#quotes.assertFresh(jobId, quoteId);
    const resolver = this.#resolver(quote);
    const jobOutPoint = parseOutPoint({
      txHash: hash(quote.snapshot.jobOutPoint.txHash, "quote job outpoint"),
      index: quote.snapshot.jobOutPoint.index,
    });

    if (operation === "cancel_job") {
      const build = await buildCancellation({ deployment, resolver, jobOutPoint, ownerLock });
      const intent = {
        action: "cancel",
        jobId: build.jobId,
        ownerLockHash: build.ownerLockHash,
        refundCapacity: build.refundCapacity.toString(),
        policy: build.policy.kind,
      };
      return Object.freeze({
        response: envelope({
          operation,
          transaction: build.transaction,
          signingEntries: ownerSigningEntries,
          intent,
          chainSnapshot: quote.snapshot,
          quoteExpiry: quote.expiry,
          quote,
        }),
        assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
          assertCancellationCompletion(build, transaction),
      });
    }
    if (operation === "recover_job") {
      const reason = text(request["reason"], "reason");
      if (!RECOVERY_REASONS.includes(reason as (typeof RECOVERY_REASONS)[number])) {
        throw new TypeError("reason is unsupported");
      }
      const build = await buildRecovery({
        deployment,
        resolver,
        jobOutPoint,
        ownerLock,
        reason: reason as (typeof RECOVERY_REASONS)[number],
      });
      return Object.freeze({
        response: envelope({
          operation,
          transaction: build.transaction,
          signingEntries: ownerSigningEntries,
          intent: build.preview,
          chainSnapshot: quote.snapshot,
          quoteExpiry: quote.expiry,
          quote,
        }),
        assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
          assertRecoveryCompletion(build, transaction),
      });
    }
    const build = await buildTopUp({
      deployment,
      resolver,
      jobOutPoint,
      ownerLock,
      rewardIncrease: decimal(request["rewardIncrease"], "rewardIncrease"),
      budgetIncrease: decimal(request["budgetIncrease"], "budgetIncrease"),
      capacityIncrease: decimal(request["capacityIncrease"], "capacityIncrease"),
    });
    return Object.freeze({
      response: envelope({
        operation,
        transaction: build.transaction,
        signingEntries: ownerSigningEntries,
        intent: {
          action: "top_up",
          jobId: build.jobId,
          ownerLockHash: build.ownerLockHash,
          diff: build.diff,
        },
        chainSnapshot: quote.snapshot,
        quoteExpiry: quote.expiry,
        quote,
      }),
      assertCompletion: (transaction: UnsignedDeadlineTransaction) =>
        assertTopUpCompletion(build, transaction),
    });
  }

  #resolver(quote: JobQuote): LiveCellResolver {
    return {
      resolve: async (point) => {
        if (
          point.txHash !== quote.snapshot.jobOutPoint.txHash ||
          point.index.toString() !== quote.snapshot.jobOutPoint.index
        ) {
          return null;
        }
        const response = await this.#chain.getTransactionStatus(point.txHash);
        if (!response || response.status !== "committed") return null;
        const index = Number(point.index);
        const output = response.transaction.outputs[index];
        const data = response.transaction.outputsData[index];
        if (!output || !data || dataHash(data) !== quote.snapshot.jobDataHash) return null;
        return Object.freeze({
          outPoint: point,
          output: Object.freeze({
            capacity: output.capacity,
            lock: script(output.lock, "committed output lock"),
            type: output.type ? script(output.type, "committed output type") : null,
          }),
          data,
        });
      },
    };
  }

  #mapBuildError(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (error instanceof CkbClientError) {
      throw new ServiceUnavailableException(
        { status: "unavailable", code: error.code },
        { cause: error },
      );
    }
    if (
      error instanceof CancellationBuildError ||
      error instanceof RecoveryBuildError ||
      error instanceof TopUpBuildError
    ) {
      const response = { status: "invalid_request", code: error.code, message: error.message };
      if (error.code === "STALE_OUTPOINT") throw new ConflictException(response);
      throw new BadRequestException(response);
    }
    throw new BadRequestException({
      status: "invalid_request",
      code: "INVALID_TRANSACTION_REQUEST",
      message: error instanceof Error ? error.message : "transaction request is invalid",
    });
  }
}

export class TransactionController {
  readonly #transactions: TransactionBuildService;

  constructor(transactions: TransactionBuildService) {
    this.#transactions = transactions;
  }

  createDeadline(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("create_deadline_job", body);
  }

  createRecurring(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("create_recurring_job", body);
  }

  cancel(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("cancel_job", body);
  }

  recover(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("recover_job", body);
  }

  topUp(body: unknown): Promise<TransactionBuildResponse> {
    return this.#transactions.construct("top_up_job", body);
  }

  validateSigned(body: unknown): Promise<SignedTransactionValidation> {
    return this.#transactions.validate(body);
  }
}

const decimalSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const scriptSchema = {
  type: "object",
  required: ["codeHash", "hashType", "args"],
  additionalProperties: false,
  properties: {
    codeHash: hashSchema,
    hashType: { type: "string", enum: ["data", "data1", "type"] },
    args: { type: "string", pattern: "^0x(?:[0-9a-f]{2})*$" },
  },
};
const ownerProperties = {
  jobId: hashSchema,
  quoteId: { type: "string", pattern: "^[0-9a-f]{64}$" },
  ownerLock: scriptSchema,
};
const numericHexSchema = { type: "string", pattern: "^0x(?:0|[1-9a-f][0-9a-f]*)$" };
const bytesSchema = { type: "string", pattern: "^0x(?:[0-9a-f]{2})*$" };
const hexOutPointSchema = {
  type: "object",
  required: ["txHash", "index"],
  additionalProperties: false,
  properties: { txHash: hashSchema, index: numericHexSchema },
};
const transactionSchema = {
  type: "object",
  required: ["version", "cellDeps", "headerDeps", "inputs", "outputs", "outputsData", "witnesses"],
  additionalProperties: false,
  properties: {
    version: { type: "string", enum: ["0x0"] },
    cellDeps: {
      type: "array",
      items: {
        type: "object",
        required: ["outPoint", "depType"],
        additionalProperties: false,
        properties: {
          outPoint: hexOutPointSchema,
          depType: { type: "string", enum: ["code", "depGroup"] },
        },
      },
    },
    headerDeps: { type: "array", items: hashSchema },
    inputs: {
      type: "array",
      items: {
        type: "object",
        required: ["since", "previousOutput"],
        additionalProperties: false,
        properties: { since: numericHexSchema, previousOutput: hexOutPointSchema },
      },
    },
    outputs: {
      type: "array",
      items: {
        type: "object",
        required: ["capacity", "lock", "type"],
        additionalProperties: false,
        properties: {
          capacity: numericHexSchema,
          lock: scriptSchema,
          type: { ...scriptSchema, nullable: true },
        },
      },
    },
    outputsData: { type: "array", items: bytesSchema },
    witnesses: { type: "array", items: bytesSchema },
  },
};
const responseSchema = {
  type: "object",
  required: [
    "operation",
    "transaction",
    "signingEntries",
    "intent",
    "intentHash",
    "protocolIntentHash",
    "policyCriticalHash",
    "chainSnapshot",
    "quoteExpiry",
    "quote",
  ],
  properties: {
    operation: { type: "string", enum: [...TRANSACTION_OPERATIONS] },
    transaction: transactionSchema,
    signingEntries: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "inputIndices", "walletAction"],
        additionalProperties: false,
        properties: {
          role: { type: "string", enum: ["funding", "owner_authorization", "pledge"] },
          inputIndices: { type: "array", items: decimalSchema },
          walletAction: {
            type: "string",
            enum: ["append_inputs_and_change", "sign_existing_inputs"],
          },
        },
      },
    },
    intent: { type: "object" },
    intentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    protocolIntentHash: { ...hashSchema, nullable: true },
    policyCriticalHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    chainSnapshot: { type: "object" },
    quoteExpiry: {
      type: "object",
      required: ["afterBlock", "condition"],
      properties: {
        afterBlock: decimalSchema,
        condition: {
          type: "string",
          enum: ["tip_change_before_signing", "tip_or_job_snapshot_change"],
        },
      },
    },
    quote: { type: "object" },
  },
};

Injectable()(TransactionBuildService);
Inject(TransactionBuildService)(TransactionController, undefined, 0);
Controller("transactions")(TransactionController);
ApiTags("transactions")(TransactionController);

const routes = [
  ["createDeadline", "create-deadline-job", "Build a deadline Job transaction"],
  ["createRecurring", "create-recurring-job", "Build a recurring Job transaction"],
  ["cancel", "cancel-job", "Build an owner cancellation transaction"],
  ["recover", "recover-job", "Build an owner recovery transaction"],
  ["topUp", "top-up-job", "Build an owner top-up transaction"],
  ["validateSigned", "validate-signed", "Validate and dry-run a wallet-completed transaction"],
] as const;
for (const [method, path, summary] of routes) {
  const descriptor = Object.getOwnPropertyDescriptor(TransactionController.prototype, method)!;
  Post(path)(TransactionController.prototype, method, descriptor);
  HttpCode(200)(TransactionController.prototype, method, descriptor);
  Body()(TransactionController.prototype, method, 0);
  ApiOperation({ summary })(TransactionController.prototype, method, descriptor);
  ApiBadRequestResponse({ description: "Malformed or policy-inconsistent transaction request" })(
    TransactionController.prototype,
    method,
    descriptor,
  );
  ApiConflictResponse({ description: "Quote or live outpoint is stale" })(
    TransactionController.prototype,
    method,
    descriptor,
  );
  ApiServiceUnavailableResponse({ description: "Chain or deployment evidence is unavailable" })(
    TransactionController.prototype,
    method,
    descriptor,
  );
}

const deadlineBodySchema = {
  type: "object",
  required: [
    "pledges",
    "target",
    "deadlineBlock",
    "successLockHash",
    "cancelLockHash",
    "reward",
    "creatorNonce",
  ],
  additionalProperties: false,
  properties: {
    pledges: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["outPoint", "refundLockHash", "amount"],
        additionalProperties: false,
        properties: {
          outPoint: {
            type: "object",
            required: ["txHash", "index"],
            properties: { txHash: hashSchema, index: decimalSchema },
          },
          refundLockHash: hashSchema,
          amount: decimalSchema,
        },
      },
    },
    target: decimalSchema,
    deadlineBlock: decimalSchema,
    successLockHash: hashSchema,
    cancelLockHash: hashSchema,
    reward: decimalSchema,
    creatorNonce: decimalSchema,
  },
};
const recurringBodySchema = {
  type: "object",
  required: [
    "ownerLockHash",
    "recipientLockHash",
    "amount",
    "intervalBlocks",
    "firstNotBefore",
    "totalRuns",
    "reward",
    "creatorNonce",
  ],
  additionalProperties: false,
  properties: {
    ownerLockHash: hashSchema,
    recipientLockHash: hashSchema,
    amount: decimalSchema,
    intervalBlocks: decimalSchema,
    firstNotBefore: decimalSchema,
    totalRuns: decimalSchema,
    reward: decimalSchema,
    creatorNonce: decimalSchema,
  },
};
const ownerBodySchema = {
  type: "object",
  required: ["jobId", "quoteId", "ownerLock"],
  additionalProperties: false,
  properties: ownerProperties,
};
const recoveryBodySchema = {
  ...ownerBodySchema,
  required: [...ownerBodySchema.required, "reason"],
  properties: {
    ...ownerProperties,
    reason: { type: "string", enum: [...RECOVERY_REASONS] },
  },
};
const topUpBodySchema = {
  ...ownerBodySchema,
  required: [...ownerBodySchema.required, "rewardIncrease", "budgetIncrease", "capacityIncrease"],
  properties: {
    ...ownerProperties,
    rewardIncrease: decimalSchema,
    budgetIncrease: decimalSchema,
    capacityIncrease: decimalSchema,
  },
};

for (const [method, schema] of [
  ["createDeadline", deadlineBodySchema],
  ["createRecurring", recurringBodySchema],
  ["cancel", ownerBodySchema],
  ["recover", recoveryBodySchema],
  ["topUp", topUpBodySchema],
] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(TransactionController.prototype, method)!;
  ApiBody({ schema: schema as never })(TransactionController.prototype, method, descriptor);
  ApiOkResponse({ schema: responseSchema as never })(
    TransactionController.prototype,
    method,
    descriptor,
  );
}

const validateDescriptor = Object.getOwnPropertyDescriptor(
  TransactionController.prototype,
  "validateSigned",
)!;
ApiBody({
  schema: {
    type: "object",
    required: ["operation", "request", "intentHash", "policyCriticalHash", "transaction"],
    additionalProperties: false,
    properties: {
      operation: { type: "string", enum: [...TRANSACTION_OPERATIONS] },
      request: {
        oneOf: [
          deadlineBodySchema,
          recurringBodySchema,
          ownerBodySchema,
          recoveryBodySchema,
          topUpBodySchema,
        ],
      },
      intentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      policyCriticalHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      transaction: transactionSchema,
    },
  },
})(TransactionController.prototype, "validateSigned", validateDescriptor);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["valid", "operation", "intentHash", "policyCriticalHash", "dryRunCycles"],
    properties: {
      valid: { type: "boolean", enum: [true] },
      operation: { type: "string", enum: [...TRANSACTION_OPERATIONS] },
      intentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      policyCriticalHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      dryRunCycles: decimalSchema,
    },
  },
})(TransactionController.prototype, "validateSigned", validateDescriptor);
ApiUnprocessableEntityResponse({ description: "Completed transaction fails CKB dry-run" })(
  TransactionController.prototype,
  "validateSigned",
  validateDescriptor,
);
