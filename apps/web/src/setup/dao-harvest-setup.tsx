"use client";

import { CheckCircle2, ExternalLink, LoaderCircle, ShieldCheck, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiClientError, createApiClient, type ApiDaoHarvestBuild } from "@ckb-automata/api-client";
import { Button, InlineNotice, TextField } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { ckbTestnetTransactionUrl, shortenCkbAddress } from "../ccc/wallet-display.ts";
import { browserWebEnvironment } from "../environment.ts";
import { automationTitle, writeAutomationTitle } from "./automation-title.ts";
import {
  DAO_HARVEST_INITIAL_DRAFT,
  DAO_HARVEST_MAX_CYCLES,
  DAO_HARVEST_REWARD_PER_ACTION_CKB,
  daoHarvestFundingPreview,
  daoHarvestSetupRequest,
  validateDaoHarvestStep,
  type DaoHarvestValidationContext,
} from "./dao-harvest-form.ts";
import {
  daoHarvestReviewSnapshot,
  verifyCompletedDaoHarvestTransaction,
  verifyDaoHarvestSetupBuild,
  verifyRefreshedDaoHarvestPolicy,
} from "./dao-harvest-review.ts";
import { DAO_HARVEST_SETUP_STEPS, type SetupDraft } from "./setup-flow.ts";
import { SetupStepper, type SetupStepRenderContext } from "./setup-stepper.tsx";

interface HarvestReview {
  readonly build: ApiDaoHarvestBuild;
  readonly completed: ApiDaoHarvestBuild["transaction"];
  readonly key: string;
  readonly snapshot: {
    readonly blockHash: string;
    readonly blockNumber: string;
    readonly expiresAfterBlock: string;
  };
  readonly transactionHash: string;
}

type ReviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: HarvestReview };

type SubmissionState =
  | { readonly status: "idle" | "submitting" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "submitted";
      readonly jobId?: string;
      readonly registration: "registered" | "retry";
      readonly transactionHash: string;
    };

const REVIEW_STORAGE_KEY = "ckb-automata.dao-harvest.review.v1";

function api() {
  return createApiClient({ baseUrl: browserWebEnvironment().apiUrl });
}

function reviewKey(draft: SetupDraft, ownerLockHash: string | undefined): string {
  return JSON.stringify({ draft, ownerLockHash });
}

function error(context: SetupStepRenderContext, name: string) {
  const message = context.errors[name];
  return message === undefined ? {} : { error: message };
}

function reviewFailure(reason: unknown): string {
  if (reason instanceof ApiClientError) {
    if (reason.status === 409) return "The chain changed. Build a fresh review.";
    if (reason.status >= 500) return "The testnet harvest builder is temporarily unavailable.";
    return "These harvest settings could not be prepared.";
  }
  if (reason instanceof TypeError) return "The testnet service could not be reached.";
  return reason instanceof Error ? reason.message : "The transaction review could not be built.";
}

async function registerHarvestSubmission(transactionHash: string): Promise<void> {
  let failure: unknown;
  for (const delay of [0, 750, 1_500]) {
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      await api().registerDaoHarvestSetup({ transactionHash });
      return;
    } catch (reason) {
      failure = reason;
    }
  }
  throw failure;
}

function HarvestDetails(context: SetupStepRenderContext) {
  const session = useWalletSession();
  const recurrence = context.draft["recurrence"] ?? "once";
  let preview: ReturnType<typeof daoHarvestFundingPreview> | undefined;
  try {
    preview = daoHarvestFundingPreview(context.draft);
  } catch {
    preview = undefined;
  }
  return (
    <div className="setup-step__group">
      <div>
        <h2>Harvest details</h2>
        <p>
          Your original amount stays protected. Only earned compensation goes to the payout address.
        </p>
      </div>
      <div className="setup-form-grid">
        <TextField
          {...error(context, "title")}
          hint="Optional. This name is shown on this browser."
          label="Automation title"
          maxLength={80}
          name="title"
          onChange={(event) => context.setField("title", event.target.value)}
          placeholder="My DAO compensation"
          value={context.draft["title"] ?? ""}
        />
        <TextField
          {...error(context, "principalCkb")}
          hint="This exact amount is re-deposited after every harvest. Minimum 210 CKB."
          inputMode="decimal"
          label="Original amount (CKB)"
          name="principalCkb"
          onChange={(event) => context.setField("principalCkb", event.target.value)}
          placeholder="1000"
          required
          value={context.draft["principalCkb"] ?? ""}
        />
        <TextField
          {...error(context, "payoutAddress")}
          autoComplete="off"
          hint="Earned compensation is sent here after each completed harvest."
          label="Compensation address"
          name="payoutAddress"
          onChange={(event) => context.setField("payoutAddress", event.target.value)}
          placeholder="ckt1..."
          required
          value={context.draft["payoutAddress"] ?? ""}
        />
      </div>
      <fieldset
        className="setup-outcome"
        data-invalid={context.errors["cycleCount"] ? "true" : undefined}
      >
        <legend>How often?</legend>
        <div>
          <button
            aria-checked={recurrence === "once"}
            onClick={() => context.setField("recurrence", "once")}
            role="radio"
            type="button"
          >
            One harvest
          </button>
          <button
            aria-checked={recurrence === "finite"}
            onClick={() => context.setField("recurrence", "finite")}
            role="radio"
            type="button"
          >
            Several harvests
          </button>
        </div>
      </fieldset>
      {recurrence === "finite" ? (
        <div className="harvest-count-field">
          <TextField
            {...error(context, "cycleCount")}
            hint={`Choose 2 to ${DAO_HARVEST_MAX_CYCLES}. You can stop future harvests later.`}
            inputMode="numeric"
            label="Number of harvests"
            max={DAO_HARVEST_MAX_CYCLES}
            min="2"
            name="cycleCount"
            onChange={(event) => context.setField("cycleCount", event.target.value)}
            required
            value={context.draft["cycleCount"] ?? ""}
          />
        </div>
      ) : null}
      {session.status === "ready" ? (
        <div
          data-field-name="ownerAddress"
          tabIndex={context.errors["ownerAddress"] ? -1 : undefined}
        >
          <InlineNotice
            title={
              context.errors["ownerAddress"]
                ? "Wallet cannot cover this plan"
                : "Owner wallet connected"
            }
            tone={context.errors["ownerAddress"] ? "danger" : "success"}
          >
            <p>
              {context.errors["ownerAddress"] ??
                `${shortenCkbAddress(session.address ?? "")}. This wallet keeps stop, exit, and recovery control.`}
            </p>
          </InlineNotice>
        </div>
      ) : (
        <InlineNotice
          title={session.status === "wrong_network" ? "Switch to CKB testnet" : "Wallet required"}
          tone="warning"
        >
          <p>Connect a supported CKB testnet wallet to fund and control this automation.</p>
          <Button
            icon={<WalletCards aria-hidden="true" size={17} />}
            onClick={session.open}
            tone="secondary"
          >
            Connect wallet
          </Button>
        </InlineNotice>
      )}
      {preview === undefined ? null : (
        <dl className="harvest-cost-preview" aria-label="Estimated deposit total">
          <div>
            <dt>Original amount</dt>
            <dd>{preview.principalCkb} CKB</dd>
          </div>
          <div>
            <dt>Estimated charges</dt>
            <dd>{preview.chargesCkb} CKB</dd>
          </div>
          <div>
            <dt>Total to deposit</dt>
            <dd>{preview.totalCkb} CKB</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function HarvestReviewStep({
  context,
  onState,
  state,
}: Readonly<{
  context: SetupStepRenderContext;
  onState: (state: ReviewState) => void;
  state: ReviewState;
}>) {
  const session = useWalletSession();
  const key = reviewKey(context.draft, session.ownerLockHash);
  useEffect(() => {
    if (session.status !== "ready" || session.ownerLockHash === undefined) {
      onState({ status: "error", message: "Connect a supported CKB testnet wallet first." });
      return;
    }
    let active = true;
    onState({ status: "loading" });
    void (async () => {
      const client = api();
      const [ownerLock, payoutLock] = await Promise.all([
        session.getOwnerLock(session.ownerLockHash!),
        session.resolveLock(context.draft["payoutAddress"] ?? ""),
      ]);
      const payoutLockHash = session.reviewLockHash(payoutLock);
      const request = daoHarvestSetupRequest(context.draft, {
        ownerLockHash: session.ownerLockHash,
        ownerLock,
        payoutLock,
        payoutLockHash,
      });
      const [build, network, signerGenesis] = await Promise.all([
        client.createDaoHarvest(request),
        client.network() as Promise<{
          readonly tip: { readonly blockHash: string; readonly blockNumber: string };
        }>,
        session.getSignerGenesisHash(),
      ]);
      if (signerGenesis !== browserWebEnvironment().genesisHash) {
        throw new Error("The connected wallet is not using CKB testnet.");
      }
      verifyDaoHarvestSetupBuild(build, {
        ownerLockHash: request.ownerLockHash,
        payoutLockHash: request.payoutLockHash,
        principal: BigInt(request.principal),
        totalCycles: request.totalCycles,
      });
      const completed = await session.completeForReview(build.transaction);
      verifyCompletedDaoHarvestTransaction(build.transaction, completed.transaction);
      const value: HarvestReview = {
        build,
        completed: completed.transaction,
        key,
        snapshot: daoHarvestReviewSnapshot(network.tip),
        transactionHash: completed.hash,
      };
      window.sessionStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(value));
      if (active) onState({ status: "ready", value });
    })().catch((reason: unknown) => {
      if (active) onState({ status: "error", message: reviewFailure(reason) });
    });
    return () => {
      active = false;
    };
  }, [context.draft, key, onState, session]);

  if (state.status === "loading" || state.status === "idle") {
    return (
      <div className="setup-review-loading">
        <LoaderCircle className="setup-review-loading__icon" />
        <div>
          <h2>Preparing review</h2>
          <p>Checking the exact deposit and charges. Your wallet will not open yet.</p>
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <InlineNotice title="Review unavailable" tone="danger">
        <p>{state.message}</p>
      </InlineNotice>
    );
  }
  const preview = daoHarvestFundingPreview(context.draft);
  const review = state.value;
  return (
    <div className="setup-review">
      <div className="setup-review__heading">
        <div>
          <h2>{automationTitle(context.draft) ?? "Harvest compensation"}</h2>
          <p>Confirm what stays deposited and what can be paid out.</p>
        </div>
        <span className="setup-review__verified">
          <ShieldCheck size={17} />
          Transaction checked
        </span>
      </div>
      <section className="setup-review__section">
        <h3>Deposit summary</h3>
        <dl className="setup-review__values">
          <div>
            <dt>Original amount protected</dt>
            <dd>{preview.principalCkb} CKB</dd>
          </div>
          <div>
            <dt>Estimated charges</dt>
            <dd>{preview.chargesCkb} CKB</dd>
          </div>
          <div>
            <dt>Total to deposit</dt>
            <dd>{preview.totalCkb} CKB</dd>
          </div>
          <div>
            <dt>Number of harvests</dt>
            <dd>{preview.cycleCount}</dd>
          </div>
        </dl>
      </section>
      <InlineNotice title="What happens" tone="info">
        <p>
          At each DAO cycle, CKAutomata prepares the withdrawal, then re-deposits the exact original
          amount and sends only the earned compensation to your chosen address.
        </p>
      </InlineNotice>
      <details className="setup-review__technical">
        <summary>Technical fee details</summary>
        <dl>
          <div>
            <dt>Executor reward</dt>
            <dd>
              {DAO_HARVEST_REWARD_PER_ACTION_CKB} CKB for each of {preview.actionCount.toString()}{" "}
              actions
            </dd>
          </div>
          <div>
            <dt>Estimated network fee</dt>
            <dd>1 CKB</dd>
          </div>
          <div>
            <dt>Policy proof</dt>
            <dd>
              <code>{review.build.policyCriticalHash}</code>
            </dd>
          </div>
          <div>
            <dt>Transaction</dt>
            <dd>
              <code>{review.transactionHash}</code>
            </dd>
          </div>
        </dl>
        <p>
          The {preview.recoverableReserveCkb} CKB automation reserve and unused executor rewards
          remain owner-recoverable. Network fees and final compensation depend on live chain
          conditions.
        </p>
      </details>
      <InlineNotice title="Testnet pilot" tone="warning">
        <p>
          This feature is unaudited and available only on CKB testnet. Compensation and timing are
          estimates, not guarantees.
        </p>
      </InlineNotice>
    </div>
  );
}

function readStoredReview(key: string): HarvestReview | undefined {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(REVIEW_STORAGE_KEY) ?? "null",
    ) as HarvestReview | null;
    return value?.key === key ? value : undefined;
  } catch {
    return undefined;
  }
}

function HarvestApproval({
  context,
  reviewState,
}: Readonly<{ context: SetupStepRenderContext; reviewState: ReviewState }>) {
  const session = useWalletSession();
  const key = reviewKey(context.draft, session.ownerLockHash);
  const review = reviewState.status === "ready" ? reviewState.value : readStoredReview(key);
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  if (review === undefined)
    return (
      <InlineNotice title="Fresh review required" tone="warning">
        <p>Return to Review and rebuild the exact transaction before approving it.</p>
      </InlineNotice>
    );

  const submit = async () => {
    if (state.status === "submitting") return;
    setState({ status: "submitting" });
    try {
      if (session.ownerLockHash === undefined) throw new Error("Reconnect the owner wallet first.");
      const [ownerLock, payoutLock] = await Promise.all([
        session.getOwnerLock(session.ownerLockHash),
        session.resolveLock(context.draft["payoutAddress"] ?? ""),
      ]);
      const payoutLockHash = session.reviewLockHash(payoutLock);
      const request = daoHarvestSetupRequest(context.draft, {
        ownerLockHash: session.ownerLockHash,
        ownerLock,
        payoutLock,
        payoutLockHash,
      });
      const refreshed = await api().createDaoHarvest(request);
      verifyDaoHarvestSetupBuild(refreshed, {
        ownerLockHash: request.ownerLockHash,
        payoutLockHash: request.payoutLockHash,
        principal: BigInt(request.principal),
        totalCycles: request.totalCycles,
      });
      verifyRefreshedDaoHarvestPolicy(review.build, refreshed);
      const signed = await session.signReviewedTransaction(
        review.completed,
        review.transactionHash,
        review.snapshot,
      );
      const transactionHash = await session.submitSignedTransaction(signed, review.transactionHash);
      let registration: "registered" | "retry" = "registered";
      try {
        await registerHarvestSubmission(transactionHash);
      } catch {
        registration = "retry";
      }
      if (review.build.jobId !== undefined) {
        writeAutomationTitle(
          window.localStorage,
          review.build.jobId,
          automationTitle(context.draft),
        );
      }
      window.sessionStorage.removeItem(REVIEW_STORAGE_KEY);
      setState({
        status: "submitted",
        ...(review.build.jobId === undefined ? {} : { jobId: review.build.jobId }),
        registration,
        transactionHash,
      });
    } catch (reason) {
      setState({ status: "error", message: reviewFailure(reason) });
    }
  };

  if (state.status === "submitted") {
    return (
      <div className="setup-submission-success">
        <span className="setup-submission-success__icon">
          <CheckCircle2 />
        </span>
        <div>
          <p className="setup-submission-success__eyebrow">Submitted</p>
          <h2>Your harvest automation is confirming</h2>
        </div>
        <p>It now appears in Automations while the testnet confirms it.</p>
        {state.registration === "retry" ? (
          <InlineNotice title="Transaction submitted" tone="warning">
            <p>The transaction succeeded, but its list entry still needs to be registered.</p>
            <Button
              onClick={() => {
                void registerHarvestSubmission(state.transactionHash)
                  .then(() => setState({ ...state, registration: "registered" }))
                  .catch(() => undefined);
              }}
              tone="secondary"
            >
              Retry listing
            </Button>
          </InlineNotice>
        ) : null}
        <code>{state.transactionHash}</code>
        <div className="setup-submission-success__actions">
          <a className="ui-button ui-button--primary" href="/automations">
            View automations
          </a>
          <a
            className="ui-button ui-button--secondary"
            href={ckbTestnetTransactionUrl(state.transactionHash)}
            rel="noreferrer"
            target="_blank"
          >
            Open transaction <ExternalLink size={15} />
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="setup-approval">
      <div className="setup-approval__heading">
        <ShieldCheck size={22} />
        <div>
          <h2>Approve in your wallet</h2>
          <p>Your wallet will sign only the transaction you reviewed.</p>
        </div>
      </div>
      <dl className="setup-approval__values">
        <div>
          <dt>Transaction</dt>
          <dd>
            <code>{review.transactionHash}</code>
          </dd>
        </div>
        <div>
          <dt>Owner wallet</dt>
          <dd>{shortenCkbAddress(session.address ?? "Not connected")}</dd>
        </div>
      </dl>
      {state.status === "error" ? (
        <InlineNotice title="Submission stopped" tone="danger">
          <p>{state.message}</p>
        </InlineNotice>
      ) : null}
      {session.status === "ready" ? (
        <Button
          disabled={state.status === "submitting"}
          icon={
            state.status === "submitting" ? (
              <LoaderCircle className="setup-review-loading__icon" size={17} />
            ) : (
              <WalletCards size={17} />
            )
          }
          onClick={() => void submit()}
        >
          {state.status === "submitting" ? "Waiting for wallet..." : "Approve and submit"}
        </Button>
      ) : (
        <InlineNotice title="Reconnect the owner wallet" tone="warning">
          <Button onClick={session.open} tone="secondary">
            Connect wallet
          </Button>
        </InlineNotice>
      )}
      <p className="setup-approval__footnote">
        Closing or rejecting the wallet request does not submit anything.
      </p>
    </div>
  );
}

function HarvestStep({
  context,
  onReviewState,
  reviewState,
}: Readonly<{
  context: SetupStepRenderContext;
  onReviewState: (state: ReviewState) => void;
  reviewState: ReviewState;
}>) {
  if (context.step === "details") return <HarvestDetails {...context} />;
  if (context.step === "review")
    return <HarvestReviewStep context={context} onState={onReviewState} state={reviewState} />;
  if (context.step === "approval")
    return <HarvestApproval context={context} reviewState={reviewState} />;
  return null;
}

export function DaoHarvestSetup() {
  const session = useWalletSession();
  const [reviewState, setReviewState] = useState<ReviewState>({ status: "idle" });
  const onReviewState = useCallback((state: ReviewState) => setReviewState(state), []);
  const validationContext = useMemo<DaoHarvestValidationContext>(
    () => ({
      balanceShannons: session.balanceShannons,
      ownerLockHash: session.ownerLockHash,
      resolveLockHash: session.resolveLockHash,
      walletAddress: session.address,
      walletReady: session.status === "ready",
    }),
    [
      session.address,
      session.balanceShannons,
      session.ownerLockHash,
      session.resolveLockHash,
      session.status,
    ],
  );
  return (
    <SetupStepper
      initialDraft={DAO_HARVEST_INITIAL_DRAFT}
      isContinueDisabled={(step, draft) =>
        step === "review" &&
        !(
          reviewState.status === "ready" &&
          reviewState.value.key === reviewKey(draft, session.ownerLockHash)
        )
      }
      renderStep={(context) => (
        <HarvestStep context={context} onReviewState={onReviewState} reviewState={reviewState} />
      )}
      steps={DAO_HARVEST_SETUP_STEPS}
      template="dao-harvest"
      validateStep={(step, draft) => {
        if (step === "review")
          return reviewState.status === "ready" &&
            reviewState.value.key === reviewKey(draft, session.ownerLockHash)
            ? {}
            : {
                review:
                  reviewState.status === "error"
                    ? reviewState.message
                    : "Wait for the transaction review to finish.",
              };
        return validateDaoHarvestStep(step, draft, validationContext);
      }}
    />
  );
}
