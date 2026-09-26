import type {
  ApiJob,
  ApiJobQuote,
  ApiRequestBody,
  ApiTransactionBuild,
  ApiTransactionValidation,
} from "@ckb-automata/api-client";
import type { ScriptIdentity, UnsignedDeadlineTransaction } from "@ckb-automata/core";

export type OwnerAction = "cancel" | "recover" | "top_up";
export type RecoveryReason =
  "unsupported_metadata" | "invalid_application_state" | "terminal_operational_failure";

export interface TopUpAmounts {
  readonly budgetIncrease: string;
  readonly capacityIncrease: string;
  readonly rewardIncrease: string;
}

export type OwnerActionRequest =
  | ApiRequestBody<"TransactionController_cancel">
  | ApiRequestBody<"TransactionController_recover">
  | ApiRequestBody<"TransactionController_topUp">;

export interface OwnerActionReview {
  readonly action: OwnerAction;
  readonly artifact: ApiTransactionBuild;
  readonly request: OwnerActionRequest;
  readonly snapshot: { readonly blockHash: string; readonly blockNumber: string };
  readonly sourceOutPoint: { readonly index: string; readonly txHash: string };
  readonly transaction: UnsignedDeadlineTransaction;
  readonly transactionHash: string;
}

export interface OwnerActionRecord {
  readonly action: OwnerAction;
  readonly persistedAt: string;
  readonly transactionHash: string;
  readonly version: 1;
}

const actionOperation = {
  cancel: "cancel_job",
  recover: "recover_job",
  top_up: "top_up_job",
} as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is missing from the transaction build.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing from the transaction build.`);
  }
  return value;
}

function snapshot(artifact: ApiTransactionBuild) {
  const value = record(artifact.chainSnapshot, "Chain snapshot");
  const tip = record(value["tip"], "Chain snapshot tip");
  return Object.freeze({
    blockHash: text(tip["blockHash"], "Snapshot block hash"),
    blockNumber: text(tip["blockNumber"], "Snapshot block number"),
  });
}

function artifactOutPoint(artifact: ApiTransactionBuild) {
  const value = record(artifact.chainSnapshot, "Chain snapshot");
  const outPoint = record(value["jobOutPoint"], "Chain snapshot job outpoint");
  return Object.freeze({
    index: text(outPoint["index"], "Job outpoint index"),
    txHash: text(outPoint["txHash"], "Job outpoint transaction hash"),
  });
}

function outPointEqual(
  left: { readonly index: string; readonly txHash: string },
  right: { readonly index: string; readonly txHash: string },
): boolean {
  return left.index === right.index && left.txHash === right.txHash;
}

function reviewedInputExists(
  transaction: UnsignedDeadlineTransaction,
  outPoint: { readonly index: string; readonly txHash: string },
): boolean {
  return transaction.inputs.some(({ previousOutput }) => outPointEqual(previousOutput, outPoint));
}

export function ownerActionRequest(
  action: OwnerAction,
  jobId: string,
  quoteId: string,
  ownerLock: ScriptIdentity,
  options: { readonly reason?: RecoveryReason; readonly topUp?: TopUpAmounts } = {},
): OwnerActionRequest {
  const base = { jobId, ownerLock, quoteId } as const;
  if (action === "cancel") return base;
  if (action === "recover") {
    if (options.reason === undefined) throw new Error("Select a recovery reason.");
    return { ...base, reason: options.reason };
  }
  if (options.topUp === undefined) throw new Error("Enter the top-up amounts.");
  return { ...base, ...options.topUp };
}

export function refreshOwnerActionRequest(
  request: OwnerActionRequest,
  quoteId: string,
): OwnerActionRequest {
  return { ...request, quoteId };
}

export function assertOwner(job: ApiJob, ownerLockHash: string | undefined): void {
  if (ownerLockHash === undefined) {
    throw new Error("Connect the owner wallet before reviewing this action.");
  }
  if (ownerLockHash !== job.ownerLockHash) {
    throw new Error("The connected wallet is not the owner of this automation.");
  }
}

export async function createOwnerActionReview(
  action: OwnerAction,
  request: OwnerActionRequest,
  quote: ApiJobQuote,
  artifact: ApiTransactionBuild,
  completeForReview: (
    transaction: UnsignedDeadlineTransaction,
  ) => Promise<{ readonly hash: string; readonly transaction: UnsignedDeadlineTransaction }>,
): Promise<OwnerActionReview> {
  if (artifact.operation !== actionOperation[action]) {
    throw new Error("The API returned a different owner action.");
  }
  if (quote.jobId !== request.jobId || artifact.intentHash.length === 0) {
    throw new Error("The quote does not belong to this automation.");
  }
  if (!outPointEqual(artifactOutPoint(artifact), quote.snapshot.jobOutPoint)) {
    throw new Error("The transaction build does not match the quoted job snapshot.");
  }
  const transaction = artifact.transaction as unknown as UnsignedDeadlineTransaction;
  if (!reviewedInputExists(transaction, quote.snapshot.jobOutPoint)) {
    throw new Error("The transaction does not spend the quoted live job outpoint.");
  }
  const completed = await completeForReview(transaction);
  if (!reviewedInputExists(completed.transaction, quote.snapshot.jobOutPoint)) {
    throw new Error("Wallet completion removed the reviewed job outpoint.");
  }
  return Object.freeze({
    action,
    artifact,
    request,
    snapshot: snapshot(artifact),
    sourceOutPoint: Object.freeze({ ...quote.snapshot.jobOutPoint }),
    transaction: completed.transaction,
    transactionHash: completed.hash,
  });
}

function assertFreshArtifact(
  review: OwnerActionReview,
  quote: ApiJobQuote,
  artifact: ApiTransactionBuild,
): void {
  const nextSnapshot = snapshot(artifact);
  if (
    !outPointEqual(quote.snapshot.jobOutPoint, review.sourceOutPoint) ||
    !outPointEqual(artifactOutPoint(artifact), review.sourceOutPoint) ||
    artifact.operation !== review.artifact.operation ||
    artifact.intentHash !== review.artifact.intentHash ||
    artifact.policyCriticalHash !== review.artifact.policyCriticalHash ||
    JSON.stringify(artifact.transaction) !== JSON.stringify(review.artifact.transaction)
  ) {
    throw new Error("The job outpoint, quote, or chain snapshot changed. Build a fresh review.");
  }
  if (BigInt(nextSnapshot.blockNumber) < BigInt(review.snapshot.blockNumber)) {
    throw new Error("The chain snapshot moved backwards. Build a fresh review.");
  }
}

export interface SubmitOwnerActionDependencies {
  readonly broadcast: (
    transaction: UnsignedDeadlineTransaction,
    expectedHash: string,
  ) => Promise<string>;
  readonly build: (request: OwnerActionRequest) => Promise<ApiTransactionBuild>;
  readonly getJob: () => Promise<ApiJob>;
  readonly getQuote: () => Promise<ApiJobQuote>;
  readonly now: () => string;
  readonly resolveLiveInput: (
    input: UnsignedDeadlineTransaction["inputs"][number],
  ) => Promise<unknown>;
  readonly sign: () => Promise<UnsignedDeadlineTransaction>;
  readonly validate: (
    request: OwnerActionRequest,
    transaction: UnsignedDeadlineTransaction,
  ) => Promise<ApiTransactionValidation>;
}

export async function submitOwnerAction(
  review: OwnerActionReview,
  dependencies: SubmitOwnerActionDependencies,
): Promise<OwnerActionRecord> {
  const latestJob = await dependencies.getJob();
  if (
    latestJob.state !== "live" ||
    !outPointEqual(latestJob.source.outPoint, review.sourceOutPoint)
  ) {
    throw new Error("Another transaction already changed this automation. Refresh its details.");
  }

  const quote = await dependencies.getQuote();
  const refreshedRequest = refreshOwnerActionRequest(review.request, quote.quoteId);
  const artifact = await dependencies.build(refreshedRequest);
  assertFreshArtifact(review, quote, artifact);

  for (const input of review.transaction.inputs) await dependencies.resolveLiveInput(input);

  const signed = await dependencies.sign();
  const validation = await dependencies.validate(refreshedRequest, signed);
  if (
    validation.operation !== review.artifact.operation ||
    validation.intentHash !== review.artifact.intentHash ||
    validation.policyCriticalHash !== review.artifact.policyCriticalHash
  ) {
    throw new Error("Signed transaction validation returned a different reviewed action.");
  }
  const transactionHash = await dependencies.broadcast(signed, review.transactionHash);
  if (transactionHash !== review.transactionHash) {
    throw new Error("The submitted transaction hash differs from the reviewed transaction.");
  }
  return Object.freeze({
    action: review.action,
    persistedAt: dependencies.now(),
    transactionHash,
    version: 1,
  });
}

export function ownerActionStorageKey(jobId: string): string {
  return `ckb-automata.owner-action.${jobId}`;
}

export function writeOwnerActionRecord(
  storage: Pick<Storage, "setItem">,
  jobId: string,
  value: OwnerActionRecord,
): boolean {
  try {
    storage.setItem(ownerActionStorageKey(jobId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readOwnerActionRecord(
  storage: Pick<Storage, "getItem">,
  jobId: string,
): OwnerActionRecord | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(ownerActionStorageKey(jobId)) ?? "null");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      candidate["version"] !== 1 ||
      !["cancel", "recover", "top_up"].includes(String(candidate["action"])) ||
      typeof candidate["persistedAt"] !== "string" ||
      typeof candidate["transactionHash"] !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(candidate["transactionHash"])
    ) {
      return undefined;
    }
    return Object.freeze({
      action: candidate["action"] as OwnerAction,
      persistedAt: candidate["persistedAt"],
      transactionHash: candidate["transactionHash"],
      version: 1,
    });
  } catch {
    return undefined;
  }
}
