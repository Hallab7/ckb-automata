"use client";

import { Ban, CirclePlus, LifeBuoy, RefreshCw, Send, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  ApiClientError,
  createApiClient,
  type ApiJob,
  type ApiTransactionBuild,
} from "@ckb-automata/api-client";
import { Button, Dialog, InlineNotice, SelectField, TextField } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { browserWebEnvironment } from "../environment.ts";
import { ckbToShannons, shannonsToCkb } from "../setup/ckb-amount.ts";
import { TransactionProgressTracker } from "../setup/transaction-progress.tsx";
import {
  assertOwner,
  connectedWalletOwnsJob,
  createOwnerActionReview,
  ownerActionRequest,
  readOwnerActionRecord,
  submitOwnerAction,
  writeOwnerActionRecord,
  type OwnerAction,
  type OwnerActionRecord,
  type OwnerActionRequest,
  type OwnerActionReview,
  type RecoveryReason,
} from "./owner-action-model.ts";

type ActionState =
  | { readonly status: "idle" | "loading" }
  | { readonly error: string; readonly status: "error" }
  | { readonly review: OwnerActionReview; readonly status: "ready" | "submitting" }
  | {
      readonly persisted: boolean;
      readonly record: OwnerActionRecord;
      readonly status: "submitted";
    };

interface ActionDefinition {
  readonly confirmLabel: string;
  readonly description: string;
  readonly label: string;
  readonly reviewLabel: string;
  readonly title: string;
}

const definitions: Readonly<Record<OwnerAction, ActionDefinition>> = {
  cancel: {
    confirmLabel: "Confirm cancellation",
    description: "Stop future payments and return the remaining funds to your wallet.",
    label: "Cancel",
    reviewLabel: "Review cancellation",
    title: "Cancel automation",
  },
  recover: {
    confirmLabel: "Confirm recovery",
    description: "Recover the remaining funds from an automation that cannot continue.",
    label: "Recover",
    reviewLabel: "Review recovery",
    title: "Recover funds",
  },
  top_up: {
    confirmLabel: "Confirm top up",
    description: "Add CKB to keep this automation funded for future payments.",
    label: "Top up",
    reviewLabel: "Review top up",
    title: "Top up automation",
  },
};

function browserApiClient() {
  const environment = browserWebEnvironment();
  return createApiClient({ baseUrl: environment.apiUrl });
}

function actionError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 409) {
      return "The live job outpoint or chain snapshot changed. Refresh and build a new review.";
    }
    if (error.status === 422) {
      return "CKB rejected the signed transaction. No success has been recorded.";
    }
    if (error.status >= 500) {
      return "The CKB validation service is unavailable. No transaction was submitted.";
    }
    return "The owner action is not valid for the current job state.";
  }
  if (error instanceof TypeError) {
    return error.message.includes("CKB")
      ? error.message
      : "The testnet service could not be reached. Check the connection and retry.";
  }
  if (error instanceof Error) {
    if (/reject|denied|cancel|closed/i.test(error.message)) {
      return "The wallet request was rejected or closed. No transaction was submitted.";
    }
    return error.message;
  }
  return "The owner action was stopped before submission.";
}

function buildAction(
  action: OwnerAction,
  api: ReturnType<typeof browserApiClient>,
  request: OwnerActionRequest,
): Promise<ApiTransactionBuild> {
  if (action === "cancel") {
    return api.cancelJob(
      request as Parameters<typeof api.cancelJob>[0],
    ) as Promise<ApiTransactionBuild>;
  }
  if (action === "recover") {
    return api.recoverJob(
      request as Parameters<typeof api.recoverJob>[0],
    ) as Promise<ApiTransactionBuild>;
  }
  return api.topUpJob(
    request as Parameters<typeof api.topUpJob>[0],
  ) as Promise<ApiTransactionBuild>;
}

function ReviewFacts({ review }: Readonly<{ review: OwnerActionReview }>) {
  const quote = review.artifact.quote as {
    readonly amounts?: { readonly estimatedFee?: { readonly maximum?: string } };
  };
  const maximumFee = quote.amounts?.estimatedFee?.maximum;
  return (
    <div className="owner-action__review">
      <div>
        <strong>Ready for wallet approval</strong>
        <p>The transaction matches this automation and the latest network state.</p>
      </div>
      {maximumFee === undefined ? null : (
        <dl className="owner-action__fee">
          <div>
            <dt>Maximum network fee</dt>
            <dd>{shannonsToCkb(BigInt(maximumFee))} CKB</dd>
          </div>
        </dl>
      )}
      <details className="owner-action__technical">
        <summary>Technical details</summary>
        <dl className="owner-action__facts">
          <div>
            <dt>Transaction hash</dt>
            <dd>
              <code>{review.transactionHash}</code>
            </dd>
          </div>
          <div>
            <dt>Live input</dt>
            <dd>
              <code>
                {review.sourceOutPoint.txHash}:{review.sourceOutPoint.index}
              </code>
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function ActionDialog({
  action,
  job,
  onSubmitted,
}: Readonly<{
  action: OwnerAction;
  job: ApiJob;
  onSubmitted: (record: OwnerActionRecord, persisted: boolean) => void;
}>) {
  const definition = definitions[action];
  const session = useWalletSession();
  const [state, setState] = useState<ActionState>({ status: "idle" });
  const [reason, setReason] = useState<RecoveryReason>("terminal_operational_failure");
  const [budget, setBudget] = useState("0");
  const [capacity, setCapacity] = useState("0");
  const [reward, setReward] = useState("0");

  const prepare = useCallback(async () => {
    if (state.status === "loading" || state.status === "submitting") return;
    setState({ status: "loading" });
    try {
      if (job.state !== "live") throw new Error("This automation no longer has a live job cell.");
      const ownerLock = await session.getOwnerLock(job.ownerLockHash);
      assertOwner(job, session.reviewLockHash(ownerLock));
      const api = browserApiClient();
      const quote = await api.getJobQuote(job.jobId);
      const options =
        action === "recover"
          ? ({ reason } as const)
          : action === "top_up"
            ? ({
                topUp: {
                  budgetIncrease: ckbToShannons(budget),
                  capacityIncrease: ckbToShannons(capacity),
                  rewardIncrease: ckbToShannons(reward),
                },
              } as const)
            : {};
      const request = ownerActionRequest(action, job.jobId, quote.quoteId, ownerLock, options);
      const artifact = await buildAction(action, api, request);
      const review = await createOwnerActionReview(
        action,
        request,
        quote,
        artifact,
        session.completeForReview,
      );
      setState({ review, status: "ready" });
    } catch (error) {
      setState({ error: actionError(error), status: "error" });
    }
  }, [action, budget, capacity, job, reason, reward, session, state.status]);

  const submit = useCallback(async () => {
    if (state.status !== "ready") return;
    const review = state.review;
    setState({ review, status: "submitting" });
    try {
      const ownerLock = await session.getOwnerLock(job.ownerLockHash);
      assertOwner(job, session.reviewLockHash(ownerLock));
      const api = browserApiClient();
      const record = await submitOwnerAction(review, {
        broadcast: session.submitSignedTransaction,
        build: (request) => buildAction(action, api, request),
        getJob: () => api.getJob(job.jobId),
        getQuote: () => api.getJobQuote(job.jobId),
        now: () => new Date().toISOString(),
        resolveLiveInput: session.resolveLiveReviewInput,
        sign: () =>
          session.signReviewedTransaction(
            review.transaction,
            review.transactionHash,
            review.snapshot,
          ),
        validate: (request, transaction) =>
          api.validateSigned({
            intentHash: review.artifact.intentHash,
            operation: review.artifact.operation,
            policyCriticalHash: review.artifact.policyCriticalHash,
            request,
            transaction,
          } as Parameters<typeof api.validateSigned>[0]),
      });
      const persisted = writeOwnerActionRecord(window.localStorage, job.jobId, record);
      setState({ persisted, record, status: "submitted" });
      onSubmitted(record, persisted);
    } catch (error) {
      setState({ error: actionError(error), status: "error" });
    }
  }, [action, job, onSubmitted, session, state]);

  const triggerIcon =
    action === "cancel" ? (
      <Ban aria-hidden="true" size={16} />
    ) : action === "recover" ? (
      <LifeBuoy aria-hidden="true" size={16} />
    ) : (
      <CirclePlus aria-hidden="true" size={16} />
    );
  const tone = action === "cancel" || action === "recover" ? "secondary" : "primary";
  const ready = state.status === "ready" || state.status === "submitting";

  return (
    <Dialog
      description={definition.description}
      footer={
        state.status === "submitted" ? null : session.status !== "ready" ? (
          <Button
            icon={<WalletCards aria-hidden="true" size={16} />}
            onClick={session.open}
            tone="secondary"
          >
            Connect owner wallet
          </Button>
        ) : ready ? (
          <Button
            disabled={state.status === "submitting"}
            icon={
              state.status === "submitting" ? (
                <RefreshCw aria-hidden="true" size={16} />
              ) : (
                <Send aria-hidden="true" size={16} />
              )
            }
            onClick={() => void submit()}
            tone={action === "cancel" || action === "recover" ? "danger" : "primary"}
          >
            {state.status === "submitting" ? "Submitting..." : definition.confirmLabel}
          </Button>
        ) : (
          <Button icon={<RefreshCw aria-hidden="true" size={16} />} onClick={() => void prepare()}>
            {definition.reviewLabel}
          </Button>
        )
      }
      title={definition.title}
      trigger={
        <Button icon={triggerIcon} tone={tone}>
          {definition.label}
        </Button>
      }
    >
      <div className="owner-action__dialog">
        {action === "recover" && !ready && state.status !== "submitted" ? (
          <SelectField
            label="Why are you recovering the funds?"
            onChange={(event) => setReason(event.target.value as RecoveryReason)}
            value={reason}
          >
            <option value="terminal_operational_failure">Automation cannot continue</option>
            <option value="invalid_application_state">Automation data is invalid</option>
            <option value="unsupported_metadata">Automation type is not supported</option>
          </SelectField>
        ) : null}
        {action === "top_up" && !ready && state.status !== "submitted" ? (
          <div className="owner-action__amounts">
            <TextField
              hint="Used for future automation runs."
              inputMode="decimal"
              label="Additional service budget (CKB)"
              onChange={(event) => setBudget(event.target.value)}
              value={budget}
            />
            {job.template === "recurring" ? null : (
              <TextField
                hint="Reserved for the automation service."
                inputMode="decimal"
                label="Additional service payment (CKB)"
                onChange={(event) => setReward(event.target.value)}
                value={reward}
              />
            )}
            <TextField
              hint="Added to the CKB held by this automation."
              inputMode="decimal"
              label="Additional automation reserve (CKB)"
              onChange={(event) => setCapacity(event.target.value)}
              value={capacity}
            />
          </div>
        ) : null}
        <p className="owner-action__safety">
          The latest network state is checked again before your wallet opens. If this automation has
          already changed, the action stops safely.
        </p>
        {state.status === "loading" ? (
          <p className="owner-action__loading">
            <RefreshCw aria-hidden="true" size={17} /> Preparing review...
          </p>
        ) : null}
        {state.status === "error" ? (
          <InlineNotice title="Action stopped" tone="danger">
            <p>{state.error}</p>
          </InlineNotice>
        ) : null}
        {ready ? <ReviewFacts review={state.review} /> : null}
        {state.status === "submitted" ? (
          <TransactionProgressTracker persisted={state.persisted} record={state.record} />
        ) : null}
      </div>
    </Dialog>
  );
}

export function OwnerActions({ job }: Readonly<{ job: ApiJob }>) {
  const session = useWalletSession();
  const getSignerLockHashes = session.getSignerLockHashes;
  const jobState = job.state;
  const ownerLockHash = job.ownerLockHash;
  const [isOwner, setIsOwner] = useState(false);
  const [submission, setSubmission] = useState<{
    readonly persisted: boolean;
    readonly record: OwnerActionRecord;
  }>();
  useEffect(() => {
    const record = readOwnerActionRecord(window.localStorage, job.jobId);
    setSubmission(record === undefined ? undefined : { persisted: true, record });
  }, [job.jobId]);

  useEffect(() => {
    let active = true;
    setIsOwner(false);
    if (session.status !== "ready" || jobState !== "live") return;
    void getSignerLockHashes()
      .then((lockHashes) => {
        if (active)
          setIsOwner(connectedWalletOwnsJob({ ownerLockHash, state: jobState }, lockHashes));
      })
      .catch(() => {
        if (active) setIsOwner(false);
      });
    return () => {
      active = false;
    };
  }, [getSignerLockHashes, jobState, ownerLockHash, session.status]);

  if (!isOwner) return null;
  return (
    <section className="owner-actions" aria-labelledby="owner-actions-heading">
      <div>
        <h2 id="owner-actions-heading">Owner actions</h2>
        <p>Manage the funds held by your automation.</p>
      </div>
      <div className="owner-actions__controls">
        <ActionDialog
          action="top_up"
          job={job}
          onSubmitted={(record, persisted) => setSubmission({ persisted, record })}
        />
        <ActionDialog
          action="cancel"
          job={job}
          onSubmitted={(record, persisted) => setSubmission({ persisted, record })}
        />
        <ActionDialog
          action="recover"
          job={job}
          onSubmitted={(record, persisted) => setSubmission({ persisted, record })}
        />
      </div>
      {submission === undefined ? null : (
        <div className="owner-actions__progress">
          <TransactionProgressTracker persisted={submission.persisted} record={submission.record} />
        </div>
      )}
    </section>
  );
}
