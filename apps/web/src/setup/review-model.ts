import {
  CREATION_REVIEW_EXPIRY_CONDITION,
  CREATION_REVIEW_WINDOW_BLOCKS,
  assertDeadlineCompletion,
  assertRecurringCompletion,
  buildDeadlineCreation,
  buildRecurringCreation,
  reconstructRecurringDisplayIntent,
  type DeadlineCreationRequest,
  type RecurringCreationRequest,
  type RegisteredDeployment,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import type { ApiTransactionBuild } from "@ckb-automata/api-client";

import { shannonsToCkb } from "./ckb-amount.ts";

const TARGET_BLOCK_SECONDS = 10n;
const REBUILD_FEE = Object.freeze({
  transactionBytes: Object.freeze({ minimum: "1", maximum: "1" }),
  feeRatePerKilobyte: Object.freeze({ minimum: "0", maximum: "0" }),
});

export type CreationRequest =
  | {
      readonly operation: "create_deadline_job";
      readonly value: DeadlineCreationRequest;
    }
  | {
      readonly operation: "create_recurring_job";
      readonly value: RecurringCreationRequest;
    };

export type CreationSubmissionRequest =
  | {
      readonly operation: "create_deadline_job";
      readonly value: DeadlineCreationRequest & {
        readonly lockResolutions: readonly ScriptIdentity[];
      };
    }
  | {
      readonly operation: "create_recurring_job";
      readonly value: RecurringCreationRequest & {
        readonly lockResolutions: readonly ScriptIdentity[];
      };
    };

export interface ResolvedReviewInput {
  readonly capacity: bigint;
  readonly lockHash: string;
}

export interface ReviewVerificationContext {
  readonly deployment: RegisteredDeployment;
  readonly hashLock: (script: ScriptIdentity) => string;
  readonly ownerInputLockHashes: ReadonlySet<string>;
  readonly resolveInput: (
    input: UnsignedDeadlineTransaction["inputs"][number],
    index: number,
  ) => Promise<ResolvedReviewInput>;
}

export interface ReviewLine {
  readonly label: string;
  readonly value: string;
}

export interface CreationReviewModel {
  readonly jobId: string;
  readonly operation: CreationRequest["operation"];
  readonly title: string;
  readonly summary: string;
  readonly network: string;
  readonly snapshotBlock: string;
  readonly snapshotHash: string;
  readonly genesisHash: string;
  readonly manifestSha256: string;
  readonly timing: string;
  readonly amounts: readonly ReviewLine[];
  readonly fee: string;
  readonly maximumFee: string;
  readonly change: string;
  readonly recovery: string;
  readonly immutableTerms: readonly string[];
  readonly warnings: readonly string[];
  readonly intentHash: string;
  readonly policyCriticalHash: string;
  readonly transactionHash: string;
  readonly technicalDetails: Readonly<Record<string, unknown>>;
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

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export function reviewTechnicalDetailsJson(value: unknown): string {
  return JSON.stringify(normalized(value), null, 2);
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function same(left: unknown, right: unknown, message: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} is missing from the transaction artifact`);
  }
  return value as Record<string, unknown>;
}

function decimal(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} is not a canonical amount`);
  }
  return BigInt(value);
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} is not a canonical hash`);
  }
  return value;
}

function snapshot(artifact: ApiTransactionBuild): {
  readonly block: bigint;
  readonly blockHash: string;
  readonly manifestSha256: string;
} {
  const value = record(artifact.chainSnapshot, "chain snapshot");
  const tip = record(value["tip"], "chain snapshot tip");
  const manifestSha256 = value["deploymentManifestSha256"];
  if (typeof manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new TypeError("chain snapshot manifest digest is invalid");
  }
  return {
    block: decimal(tip["blockNumber"], "snapshot block"),
    blockHash: hash(tip["blockHash"], "snapshot block hash"),
    manifestSha256,
  };
}

export function creationReviewExpiryBlock(artifact: ApiTransactionBuild): string {
  const chainSnapshot = snapshot(artifact);
  const expiry = record(artifact.quoteExpiry, "quote expiry");
  const afterBlock = decimal(expiry["afterBlock"], "quote expiry block");
  if (
    expiry["condition"] !== CREATION_REVIEW_EXPIRY_CONDITION ||
    afterBlock !== chainSnapshot.block + CREATION_REVIEW_WINDOW_BLOCKS
  ) {
    throw new Error("API review expiry does not match the bounded canonical snapshot window");
  }
  return afterBlock.toString();
}

function feeMaximum(artifact: ApiTransactionBuild): bigint {
  const quote = record(artifact.quote, "quote");
  const estimatedFee = record(quote["estimatedFee"], "estimated fee");
  return decimal(estimatedFee["maximum"], "maximum fee");
}

function lockedTotal(artifact: ApiTransactionBuild): bigint {
  return decimal(record(artifact.quote, "quote")["maximumLockedTotal"], "locked total");
}

function verifiedQuote(
  artifact: ApiTransactionBuild,
  expected: {
    readonly applicationAmount: unknown;
    readonly maximumLockedTotal: bigint;
    readonly occupiedCapacity: unknown;
    readonly remainingBudget: bigint;
    readonly residualRefund: bigint;
    readonly retainedTerminalCapacity: bigint;
    readonly rewards: unknown;
  },
): void {
  const quote = record(artifact.quote, "quote");
  for (const key of [
    "applicationAmount",
    "maximumLockedTotal",
    "occupiedCapacity",
    "remainingBudget",
    "residualRefund",
    "retainedTerminalCapacity",
    "rewards",
  ] as const) {
    same(expected[key], quote[key], `API quote ${key} does not match the rebuilt transaction`);
  }
  const estimatedFee = record(quote["estimatedFee"], "estimated fee");
  const minimum = decimal(estimatedFee["minimum"], "minimum fee");
  const maximum = decimal(estimatedFee["maximum"], "maximum fee");
  if (minimum > maximum) throw new Error("API fee estimate is not ordered");
  if (
    decimal(quote["maximumOwnerFunding"], "maximum owner funding") !==
    expected.maximumLockedTotal + maximum
  ) {
    throw new Error("API owner funding total does not match locked capacity and fee");
  }
}

function timingCopy(scheduledBlock: bigint, snapshotBlock: bigint): string {
  if (scheduledBlock <= snapshotBlock) {
    return "The scheduled time has been reached. Processing and confirmation timing can still vary.";
  }
  const seconds = (scheduledBlock - snapshotBlock) * TARGET_BLOCK_SECONDS;
  const minutes = (seconds + 59n) / 60n;
  return `Expected in about ${minutes} minute${minutes === 1n ? "" : "s"}. Network timing can vary slightly.`;
}

function recurringTimingCopy(
  firstScheduledBlock: bigint,
  intervalBlocks: bigint,
  snapshotBlock: bigint,
): string {
  const firstDelayBlocks =
    firstScheduledBlock > snapshotBlock ? firstScheduledBlock - snapshotBlock : 0n;
  const firstDelayMinutes = (firstDelayBlocks * TARGET_BLOCK_SECONDS + 59n) / 60n;
  const intervalMinutes = (intervalBlocks * TARGET_BLOCK_SECONDS + 59n) / 60n;
  const firstPayment =
    firstDelayMinutes === 0n
      ? "The first payment is ready to process"
      : `The first payment is expected in about ${firstDelayMinutes} minute${firstDelayMinutes === 1n ? "" : "s"}`;

  return `${firstPayment}, then about every ${intervalMinutes} minute${intervalMinutes === 1n ? "" : "s"}.`;
}

async function verifyEnvelope(
  artifact: ApiTransactionBuild,
  expectedOperation: CreationRequest["operation"],
): Promise<void> {
  if (artifact.operation !== expectedOperation)
    throw new Error("API operation does not match setup");
  const intentHash = await sha256({ operation: artifact.operation, intent: artifact.intent });
  if (intentHash !== artifact.intentHash)
    throw new Error("API intent hash does not match its intent");
  const policyCriticalHash = await sha256({
    operation: artifact.operation,
    intentHash: artifact.intentHash,
    quote: artifact.quote,
    chainSnapshot: artifact.chainSnapshot,
    quoteExpiry: artifact.quoteExpiry,
    transaction: artifact.transaction,
  });
  if (policyCriticalHash !== artifact.policyCriticalHash) {
    throw new Error("API policy hash does not match the unsigned transaction");
  }
}

async function verifyOwnerCompletion(
  completed: UnsignedDeadlineTransaction,
  requiredOutputCount: number,
  ownerLockHash: string,
  maximumFee: bigint,
  context: ReviewVerificationContext,
): Promise<{ readonly fee: bigint; readonly change: bigint; readonly changeCount: number }> {
  const inputs = await Promise.all(
    completed.inputs.map((input, index) => context.resolveInput(input, index)),
  );
  if (inputs.some((input) => !context.ownerInputLockHashes.has(input.lockHash))) {
    throw new Error("wallet completion added an input outside the connected owner lock");
  }
  const changeOutputs = completed.outputs.slice(requiredOutputCount);
  let change = 0n;
  for (const [offset, output] of changeOutputs.entries()) {
    const index = requiredOutputCount + offset;
    if (
      output.type !== null ||
      completed.outputsData[index] !== "0x" ||
      context.hashLock(output.lock) !== ownerLockHash
    ) {
      throw new Error("wallet completion added a non-owner change output");
    }
    change += BigInt(output.capacity);
  }
  const inputCapacity = inputs.reduce((total, input) => total + input.capacity, 0n);
  const outputCapacity = completed.outputs.reduce(
    (total, output) => total + BigInt(output.capacity),
    0n,
  );
  const fee = inputCapacity - outputCapacity;
  if (fee < 0n) throw new Error("completed transaction spends more capacity than its inputs");
  if (fee > maximumFee) throw new Error("completed transaction fee exceeds the reviewed maximum");
  return { fee, change, changeCount: changeOutputs.length };
}

export async function verifyCreationReview(
  request: CreationRequest,
  artifact: ApiTransactionBuild,
  completed: UnsignedDeadlineTransaction,
  transactionHash: string,
  context: ReviewVerificationContext,
): Promise<CreationReviewModel> {
  await verifyEnvelope(artifact, request.operation);
  const chainSnapshot = snapshot(artifact);
  creationReviewExpiryBlock(artifact);
  if (
    context.deployment.manifestSha256 !== chainSnapshot.manifestSha256 ||
    context.deployment.genesisHash !== record(artifact.intent, "normalized intent")["genesisHash"]
  ) {
    throw new Error("API intent does not match the verified deployment manifest");
  }

  const maximumFee = feeMaximum(artifact);
  const totalLocked = lockedTotal(artifact);
  let ownerLockHash: string;
  let requiredOutputCount: number;
  let title: string;
  let summary: string;
  let timing: string;
  let recovery: string;
  let amounts: readonly ReviewLine[];
  let immutableTerms: readonly string[];
  let normalizedIntent: unknown;
  let jobId: string;
  let deadlinePledged: bigint | undefined;

  if (request.operation === "create_recurring_job") {
    const build = buildRecurringCreation({
      deployment: context.deployment,
      ...request.value,
      creationFee: REBUILD_FEE,
    });
    same(build.intent, artifact.intent, "API recurring intent cannot be reproduced");
    same(build.transaction, artifact.transaction, "API recurring transaction cannot be reproduced");
    if (artifact.protocolIntentHash !== build.intentHash) {
      throw new Error("recurring policy intent hash does not match the transaction");
    }
    verifiedQuote(artifact, build.quote);
    assertRecurringCompletion(build, completed);
    same(
      reconstructRecurringDisplayIntent(completed, context.deployment),
      build.displayIntent,
      "completed recurring transaction displays a different policy intent",
    );
    ownerLockHash = request.value.ownerLockHash;
    requiredOutputCount = build.completion.requiredOutputCount;
    title = "Recurring distribution";
    summary = `${shannonsToCkb(BigInt(request.value.amount))} CKB will be available to the fixed recipient on each of ${request.value.totalRuns} scheduled runs.`;
    timing = timingCopy(BigInt(request.value.firstNotBefore), chainSnapshot.block);
    recovery =
      "After the final run, remaining Job Cell capacity returns to the connected owner. The owner also retains cancellation and recovery authority.";
    amounts = Object.freeze([
      { label: "Payment per run", value: `${shannonsToCkb(BigInt(request.value.amount))} CKB` },
      { label: "Executions", value: request.value.totalRuns },
      {
        label: "Executor reward per run",
        value: `${shannonsToCkb(BigInt(request.value.reward))} CKB`,
      },
      { label: "Total capacity locked", value: `${shannonsToCkb(totalLocked)} CKB` },
      { label: "Recoverable residual", value: `${shannonsToCkb(build.quote.residualRefund)} CKB` },
    ]);
    immutableTerms = Object.freeze([
      `Recipient lock ${request.value.recipientLockHash}`,
      `${request.value.amount} shannons per run for ${request.value.totalRuns} runs`,
      recurringTimingCopy(
        BigInt(request.value.firstNotBefore),
        BigInt(request.value.intervalBlocks),
        chainSnapshot.block,
      ),
      `${request.value.reward} shannons executor reward per run`,
      `Owner and final refund lock ${request.value.ownerLockHash}`,
    ]);
    normalizedIntent = build.intent;
    jobId = build.jobId;
  } else {
    const build = buildDeadlineCreation({
      deployment: context.deployment,
      ...request.value,
      creationFee: REBUILD_FEE,
    });
    same(build.intent, artifact.intent, "API deadline intent cannot be reproduced");
    same(build.transaction, artifact.transaction, "API deadline transaction cannot be reproduced");
    if (artifact.protocolIntentHash !== build.intentHash) {
      throw new Error("deadline policy intent hash does not match the transaction");
    }
    verifiedQuote(artifact, build.quote);
    assertDeadlineCompletion(build, completed);
    ownerLockHash = request.value.cancelLockHash;
    requiredOutputCount = build.completion.requiredOutputCount;
    title = "Scheduled payment";
    const pledged = BigInt(build.intent.pledged);
    const payRecipient = BigInt(request.value.target) <= pledged;
    summary = payRecipient
      ? `${shannonsToCkb(pledged)} CKB will be sent to the recipient at the scheduled time.`
      : `${shannonsToCkb(pledged)} CKB will be returned to the refund address at the scheduled time.`;
    timing = timingCopy(BigInt(request.value.deadlineBlock), chainSnapshot.block);
    recovery = `${shannonsToCkb(build.quote.residualRefund)} CKB of the charges is returned to your connected wallet after completion. If you cancel or recover before execution, the reserved ${shannonsToCkb(BigInt(request.value.reward))} CKB service charge is also preserved, minus network fees.`;
    amounts = Object.freeze([]);
    deadlinePledged = pledged;
    immutableTerms = Object.freeze([
      payRecipient
        ? "Pay the recipient at the scheduled time"
        : "Return the amount at the scheduled time",
      `${shannonsToCkb(pledged)} CKB recipient amount`,
      `${shannonsToCkb(BigInt(request.value.reward))} CKB fixed service charge`,
    ]);
    normalizedIntent = build.intent;
    jobId = build.jobId;
  }

  const completion = await verifyOwnerCompletion(
    completed,
    requiredOutputCount,
    ownerLockHash,
    maximumFee,
    context,
  );
  if (deadlinePledged !== undefined) {
    const charges = totalLocked - deadlinePledged + completion.fee;
    amounts = Object.freeze([
      { label: "Recipient amount", value: `${shannonsToCkb(deadlinePledged)} CKB` },
      { label: "Charges", value: `${shannonsToCkb(charges)} CKB` },
      { label: "Total amount to pay", value: `${shannonsToCkb(totalLocked + completion.fee)} CKB` },
    ]);
  }
  return Object.freeze({
    jobId,
    operation: request.operation,
    title,
    summary,
    network: context.deployment.network,
    snapshotBlock: chainSnapshot.block.toString(),
    snapshotHash: chainSnapshot.blockHash,
    genesisHash: context.deployment.genesisHash,
    manifestSha256: context.deployment.manifestSha256,
    timing,
    amounts,
    fee: `${shannonsToCkb(completion.fee)} CKB (${completion.fee} shannons), paid by the connected owner`,
    maximumFee: `${shannonsToCkb(maximumFee)} CKB (${maximumFee} shannons)`,
    change:
      completion.changeCount === 0
        ? "No change output"
        : `${shannonsToCkb(completion.change)} CKB across ${completion.changeCount} owner change output${completion.changeCount === 1 ? "" : "s"}`,
    recovery,
    immutableTerms,
    warnings: Object.freeze([
      "This transaction is for a non-mainnet deployment.",
      "Schedule times are approximate; processing does not guarantee immediate confirmation.",
      "Changing any input, committed output, policy payload, fee, or change requires a new review.",
    ]),
    intentHash: artifact.protocolIntentHash ?? artifact.intentHash,
    policyCriticalHash: artifact.policyCriticalHash,
    transactionHash,
    technicalDetails: Object.freeze({
      normalizedIntent,
      apiIntentHash: artifact.intentHash,
      protocolIntentHash: artifact.protocolIntentHash,
      policyCriticalHash: artifact.policyCriticalHash,
      chainSnapshot: artifact.chainSnapshot,
      quoteExpiry: artifact.quoteExpiry,
      signingEntries: artifact.signingEntries,
      originalTransaction: artifact.transaction,
      completedTransaction: completed,
    }),
  });
}
