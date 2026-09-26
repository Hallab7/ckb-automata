"use client";

import { RefreshCw, Send, ShieldCheck, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  ApiClientError,
  createApiClient,
  type ApiTransactionBuild,
} from "@ckb-automata/api-client";
import { deploymentRegistry, type UnsignedDeadlineTransaction } from "@ckb-automata/core";
import { Button, InlineNotice } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { browserWebEnvironment } from "../environment.ts";
import { automationTitle, writeAutomationTitle } from "./automation-title.ts";
import {
  creationReviewKey,
  type CreationReviewResult,
  type CreationReviewState,
} from "./creation-review.tsx";
import { creationReviewExpiryBlock, verifyCreationReview } from "./review-model.ts";
import type { SetupDraft, SetupTemplateId } from "./setup-flow.ts";
import {
  readSubmissionRecord,
  submitCreationReview,
  writeSubmissionRecord,
  type SubmissionOutcome,
} from "./submission-model.ts";
import { TransactionProgressTracker } from "./transaction-progress.tsx";

export type CreationSubmissionState =
  | { readonly key: string; readonly status: "idle" | "submitting" }
  | { readonly error: string; readonly key: string; readonly status: "error" }
  | { readonly key: string; readonly outcome: SubmissionOutcome; readonly status: "submitted" };

function browserApiClient() {
  const environment = browserWebEnvironment();
  return createApiClient({ baseUrl: environment.apiUrl });
}

function apiRequest(review: CreationReviewResult): unknown {
  if (review.request.operation === "create_recurring_job") return review.request.value;
  return {
    ...review.request.value,
    pledges: review.request.value.pledges.map((pledge) => ({
      ...pledge,
      outPoint: { txHash: pledge.outPoint.txHash, index: pledge.outPoint.index.toString() },
    })),
  };
}

async function refreshedArtifact(review: CreationReviewResult): Promise<ApiTransactionBuild> {
  const api = browserApiClient();
  return (
    review.request.operation === "create_recurring_job"
      ? api.createRecurringJob(review.request.value)
      : api.createDeadlineJob(apiRequest(review) as Parameters<typeof api.createDeadlineJob>[0])
  ) as Promise<ApiTransactionBuild>;
}

function submissionMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 409)
      return "The quote, snapshot, or wallet input is stale. Build a fresh review.";
    if (error.status === 422)
      return "The signed transaction failed CKB validation and was not submitted.";
    if (error.status >= 500)
      return "The CKB validation service is unavailable. No success has been recorded.";
    return "The signed transaction did not match the reviewed automation.";
  }
  if (error instanceof TypeError) {
    return "The CKB service could not be reached. Check the connection and retry.";
  }
  if (error instanceof Error) {
    if (/reject|denied|cancel|closed/i.test(error.message)) {
      return "The wallet request was rejected or closed. No transaction was submitted.";
    }
    return error.message;
  }
  return "The transaction was not submitted. Retry after checking the wallet and network.";
}

function signedValidationBody(
  review: CreationReviewResult,
  transaction: UnsignedDeadlineTransaction,
) {
  return {
    operation: review.request.operation,
    request: apiRequest(review),
    intentHash: review.artifact.intentHash,
    policyCriticalHash: review.artifact.policyCriticalHash,
    reviewContext: {
      chainSnapshot: review.artifact.chainSnapshot,
      quoteExpiry: review.artifact.quoteExpiry,
    },
    transaction,
  };
}

export function submissionStateError(
  state: CreationSubmissionState,
  expectedKey: string,
): string | undefined {
  if (state.status === "submitted" && state.key === expectedKey) return undefined;
  if (state.status === "error" && state.key === expectedKey) return state.error;
  return "Approve and submit the exact reviewed transaction before continuing.";
}

export function ApprovalPrompt({
  error,
  network,
  onConnect,
  onSubmit,
  ready,
  submitting,
  transactionHash,
  walletName,
}: Readonly<{
  error?: string;
  network: string;
  onConnect: () => void;
  onSubmit: () => void;
  ready: boolean;
  submitting: boolean;
  transactionHash: string;
  walletName?: string;
}>) {
  return (
    <div className="setup-approval" data-field-name="approval" tabIndex={-1}>
      <div className="setup-approval__heading">
        <ShieldCheck aria-hidden="true" size={22} />
        <div>
          <h2>Approve exact transaction</h2>
          <p>
            The reviewed hash, policy outputs, live inputs, and snapshot are checked again before
            the wallet opens. Signing cannot rebuild the transaction.
          </p>
        </div>
      </div>
      <dl className="setup-approval__values">
        <div>
          <dt>Wallet</dt>
          <dd>{walletName ?? "Not connected"}</dd>
        </div>
        <div>
          <dt>Transaction hash</dt>
          <dd>
            <code>{transactionHash}</code>
          </dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{network}</dd>
        </div>
      </dl>
      {error === undefined ? null : (
        <InlineNotice title="Submission stopped" tone="danger">
          <p>{error}</p>
        </InlineNotice>
      )}
      {ready ? (
        <Button
          disabled={submitting}
          icon={
            submitting ? (
              <RefreshCw aria-hidden="true" className="setup-review-loading__icon" size={17} />
            ) : (
              <Send aria-hidden="true" size={17} />
            )
          }
          onClick={onSubmit}
        >
          {submitting ? "Waiting for wallet..." : "Approve and submit"}
        </Button>
      ) : (
        <InlineNotice title="Wallet connection required" tone="warning">
          <p>Reconnect the reviewed owner wallet before signing.</p>
          <Button
            icon={<WalletCards aria-hidden="true" size={17} />}
            onClick={onConnect}
            tone="secondary"
          >
            Connect wallet
          </Button>
        </InlineNotice>
      )}
      <p className="setup-approval__footnote">
        Rejecting or closing the wallet leaves this automation unsubmitted.
      </p>
    </div>
  );
}

export function CreationApproval({
  draft,
  onStateChange,
  reviewState,
  template,
}: Readonly<{
  draft: SetupDraft;
  onStateChange: (state: CreationSubmissionState) => void;
  reviewState: CreationReviewState;
  template: SetupTemplateId;
}>) {
  const session = useWalletSession();
  const key = creationReviewKey(template, draft, session.ownerLockHash);
  const review =
    reviewState.status === "ready" && reviewState.key === key ? reviewState.result : undefined;
  const [state, setState] = useState<CreationSubmissionState>({ key, status: "idle" });

  const update = useCallback(
    (next: CreationSubmissionState) => {
      setState(next);
      onStateChange(next);
    },
    [onStateChange],
  );

  useEffect(() => {
    if (review === undefined) return;
    const stored = readSubmissionRecord(window.localStorage, template);
    if (
      stored?.reviewKey === review.key &&
      stored.reviewedTransactionHash === review.model.transactionHash
    ) {
      update({
        key,
        outcome: { persisted: true, record: stored, recovered: true },
        status: "submitted",
      });
    }
  }, [key, review, template, update]);

  const submit = useCallback(async () => {
    if (review === undefined || state.status === "submitting") return;
    const submitting = { key, status: "submitting" } as const;
    update(submitting);
    try {
      const api = browserApiClient();
      const outcome = await submitCreationReview(review, {
        broadcast: session.submitSignedTransaction,
        now: () => new Date().toISOString(),
        persist: (record) => writeSubmissionRecord(window.localStorage, template, record),
        readPersisted: () => readSubmissionRecord(window.localStorage, template),
        refreshArtifact: () => refreshedArtifact(review),
        reverify: async () => {
          const deployment = await deploymentRegistry.load(review.model.genesisHash);
          if (deployment.status !== "ok") {
            throw new Error("The reviewed deployment is no longer verified.");
          }
          const verified = await verifyCreationReview(
            review.request,
            review.artifact,
            review.transaction,
            review.model.transactionHash,
            {
              deployment: deployment.deployment,
              hashLock: session.reviewLockHash,
              ownerInputLockHashes: await session.getSignerLockHashes(),
              resolveInput: session.resolveLiveReviewInput,
            },
          );
          if (
            verified.transactionHash !== review.model.transactionHash ||
            verified.policyCriticalHash !== review.model.policyCriticalHash
          ) {
            throw new Error("The transaction no longer matches the reviewed policy.");
          }
        },
        sign: () =>
          session.signReviewedTransaction(review.transaction, review.model.transactionHash, {
            blockHash: review.model.snapshotHash,
            blockNumber: review.model.snapshotBlock,
            expiresAfterBlock: creationReviewExpiryBlock(review.artifact),
          }),
        validateSigned: (transaction) =>
          api.validateSigned(
            signedValidationBody(review, transaction) as Parameters<typeof api.validateSigned>[0],
          ),
      });
      writeAutomationTitle(window.localStorage, review.model.jobId, automationTitle(draft));
      update({ key, outcome, status: "submitted" });
    } catch (error) {
      update({ error: submissionMessage(error), key, status: "error" });
    }
  }, [draft, key, review, session, state.status, template, update]);

  if (review === undefined) {
    return (
      <InlineNotice title="Fresh review required" tone="warning">
        <p>Return to Review and verify the exact transaction before requesting wallet approval.</p>
      </InlineNotice>
    );
  }
  if (state.status === "submitted") {
    return (
      <TransactionProgressTracker
        persisted={state.outcome.persisted}
        record={state.outcome.record}
      />
    );
  }

  return (
    <ApprovalPrompt
      {...(state.status === "error" ? { error: state.error } : {})}
      network={review.model.network}
      onConnect={session.open}
      onSubmit={() => void submit()}
      ready={session.status === "ready"}
      submitting={state.status === "submitting"}
      transactionHash={review.model.transactionHash}
      {...(session.walletName === undefined ? {} : { walletName: session.walletName })}
    />
  );
}

export function CreationSubmissionResult({ template }: Readonly<{ template: SetupTemplateId }>) {
  const [record, setRecord] = useState<ReturnType<typeof readSubmissionRecord>>();
  useEffect(() => setRecord(readSubmissionRecord(window.localStorage, template)), [template]);
  if (record === undefined) {
    return (
      <InlineNotice title="No submitted transaction" tone="warning">
        <p>Return to Wallet approval. No transaction hash is stored for this setup.</p>
      </InlineNotice>
    );
  }
  return <TransactionProgressTracker record={record} />;
}
