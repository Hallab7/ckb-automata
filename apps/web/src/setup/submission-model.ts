import type { ApiTransactionBuild, ApiTransactionValidation } from "@ckb-automata/api-client";
import type { UnsignedDeadlineTransaction } from "@ckb-automata/core";

import type { CreationReviewResult } from "./creation-review.tsx";
import type { SetupTemplateId } from "./setup-flow.ts";

const STORAGE_VERSION = 1;

export interface SubmissionRecord {
  readonly operation: CreationReviewResult["request"]["operation"];
  readonly persistedAt: string;
  readonly reviewKey: string;
  readonly reviewedTransactionHash: string;
  readonly transactionHash: string;
  readonly version: typeof STORAGE_VERSION;
}

export interface SubmissionOutcome {
  readonly persisted: boolean;
  readonly record: SubmissionRecord;
  readonly recovered: boolean;
}

export interface SubmissionDependencies {
  readonly broadcast: (
    transaction: UnsignedDeadlineTransaction,
    expectedHash: string,
  ) => Promise<string>;
  readonly now: () => string;
  readonly persist: (record: SubmissionRecord) => boolean;
  readonly readPersisted: () => SubmissionRecord | undefined;
  readonly refreshArtifact: () => Promise<ApiTransactionBuild>;
  readonly reverify: () => Promise<void>;
  readonly sign: () => Promise<UnsignedDeadlineTransaction>;
  readonly validateSigned: (
    transaction: UnsignedDeadlineTransaction,
  ) => Promise<ApiTransactionValidation>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}

export function submissionStorageKey(template: SetupTemplateId): string {
  return `ckb-automata.submission.${template}`;
}

export function parseSubmissionRecord(value: string | null): SubmissionRecord | undefined {
  if (value === null) return undefined;
  try {
    const parsed = asRecord(JSON.parse(value));
    if (
      parsed?.["version"] !== STORAGE_VERSION ||
      (parsed["operation"] !== "create_deadline_job" &&
        parsed["operation"] !== "create_recurring_job") ||
      typeof parsed["persistedAt"] !== "string" ||
      typeof parsed["reviewKey"] !== "string" ||
      !hash(parsed["reviewedTransactionHash"]) ||
      !hash(parsed["transactionHash"])
    ) {
      return undefined;
    }
    return Object.freeze({
      operation: parsed["operation"],
      persistedAt: parsed["persistedAt"],
      reviewKey: parsed["reviewKey"],
      reviewedTransactionHash: parsed["reviewedTransactionHash"],
      transactionHash: parsed["transactionHash"],
      version: STORAGE_VERSION,
    });
  } catch {
    return undefined;
  }
}

export function readSubmissionRecord(
  storage: Pick<Storage, "getItem">,
  template: SetupTemplateId,
): SubmissionRecord | undefined {
  try {
    return parseSubmissionRecord(storage.getItem(submissionStorageKey(template)));
  } catch {
    return undefined;
  }
}

export function writeSubmissionRecord(
  storage: Pick<Storage, "setItem">,
  template: SetupTemplateId,
  value: SubmissionRecord,
): boolean {
  try {
    storage.setItem(submissionStorageKey(template), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function matchesReview(record: SubmissionRecord, review: CreationReviewResult): boolean {
  return (
    record.reviewKey === review.key &&
    record.reviewedTransactionHash === review.model.transactionHash &&
    record.transactionHash === review.model.transactionHash &&
    record.operation === review.request.operation
  );
}

export async function submitCreationReview(
  review: CreationReviewResult,
  dependencies: SubmissionDependencies,
): Promise<SubmissionOutcome> {
  const existing = dependencies.readPersisted();
  if (existing !== undefined && matchesReview(existing, review)) {
    return Object.freeze({ persisted: true, record: existing, recovered: true });
  }

  const refreshed = await dependencies.refreshArtifact();
  if (
    refreshed.intentHash !== review.artifact.intentHash ||
    refreshed.policyCriticalHash !== review.artifact.policyCriticalHash
  ) {
    throw new Error("The transaction quote or chain snapshot is stale. Build a fresh review.");
  }
  await dependencies.reverify();

  const signed = await dependencies.sign();
  const validation = await dependencies.validateSigned(signed);
  if (
    validation.operation !== review.request.operation ||
    validation.intentHash !== review.artifact.intentHash ||
    validation.policyCriticalHash !== review.artifact.policyCriticalHash
  ) {
    throw new Error("Signed transaction validation returned a different reviewed intent.");
  }

  const transactionHash = await dependencies.broadcast(signed, review.model.transactionHash);
  if (transactionHash !== review.model.transactionHash) {
    throw new Error("The submitted transaction hash differs from the reviewed transaction.");
  }
  const stored = Object.freeze({
    operation: review.request.operation,
    persistedAt: dependencies.now(),
    reviewKey: review.key,
    reviewedTransactionHash: review.model.transactionHash,
    transactionHash,
    version: STORAGE_VERSION,
  }) satisfies SubmissionRecord;
  return Object.freeze({
    persisted: dependencies.persist(stored),
    record: stored,
    recovered: false,
  });
}
