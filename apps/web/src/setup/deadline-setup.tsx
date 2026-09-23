"use client";

import { WalletCards } from "lucide-react";
import { useCallback, useState } from "react";

import { Button, InlineNotice, TextField } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { shortenCkbAddress } from "../ccc/wallet-display.ts";
import {
  DEADLINE_INITIAL_DRAFT,
  validateDeadlineStep,
  type DeadlineValidationContext,
} from "./deadline-form.ts";
import type { SetupStepRenderContext } from "./setup-stepper.tsx";
import { SetupStepper } from "./setup-stepper.tsx";
import { ReadonlyField } from "./readonly-field.tsx";
import {
  CreationReview,
  creationReviewKey,
  reviewStateError,
  type CreationReviewState,
} from "./creation-review.tsx";
import {
  CreationApproval,
  CreationSubmissionResult,
  submissionStateError,
  type CreationSubmissionState,
} from "./creation-submission.tsx";

function error(context: SetupStepRenderContext, name: string) {
  const message = context.errors[name];
  return message === undefined ? {} : { error: message };
}

function DeadlineDetails(context: SetupStepRenderContext) {
  const session = useWalletSession();
  return (
    <div className="setup-step__group">
      <div>
        <h2>Campaign outcome</h2>
        <p>
          The committed campaign total determines whether funds release or refund at the deadline.
        </p>
      </div>
      <div className="setup-form-grid">
        <TextField
          {...error(context, "pledgeCkb")}
          hint="At least 61 CKB so a refund output remains valid."
          inputMode="decimal"
          label="Campaign funds (CKB)"
          name="pledgeCkb"
          onChange={(event) => context.setField("pledgeCkb", event.target.value)}
          placeholder="80"
          required
          value={context.draft["pledgeCkb"] ?? ""}
        />
        <TextField
          {...error(context, "targetCkb")}
          hint="Meeting or exceeding this amount releases funds to the success recipient."
          inputMode="decimal"
          label="Success target (CKB)"
          name="targetCkb"
          onChange={(event) => context.setField("targetCkb", event.target.value)}
          placeholder="150"
          required
          value={context.draft["targetCkb"] ?? ""}
        />
        <TextField
          {...error(context, "successAddress")}
          autoComplete="off"
          hint="Receives the campaign funds when the target is met."
          label="Success recipient"
          name="successAddress"
          onChange={(event) => context.setField("successAddress", event.target.value)}
          placeholder="ckt1..."
          required
          value={context.draft["successAddress"] ?? ""}
        />
        <div className="setup-address-field">
          <TextField
            {...error(context, "refundAddress")}
            autoComplete="off"
            hint="Receives the original campaign funds when the target is missed."
            label="Refund recipient"
            name="refundAddress"
            onChange={(event) => context.setField("refundAddress", event.target.value)}
            placeholder="ckt1..."
            required
            value={context.draft["refundAddress"] ?? ""}
          />
          <Button
            disabled={session.address === undefined}
            onClick={() => {
              if (session.address !== undefined) context.setField("refundAddress", session.address);
            }}
            tone="secondary"
          >
            Use connected wallet
          </Button>
        </div>
      </div>
    </div>
  );
}

function DeadlineTiming(context: SetupStepRenderContext) {
  return (
    <div className="setup-step__group">
      <div>
        <h2>Deadline timing</h2>
        <p>Finalization becomes eligible when CKB reaches this absolute testnet block.</p>
      </div>
      <TextField
        {...error(context, "deadlineBlock")}
        hint="Use a future CKB Pudge Testnet block number."
        inputMode="numeric"
        label="Deadline block"
        name="deadlineBlock"
        onChange={(event) => context.setField("deadlineBlock", event.target.value)}
        placeholder="15000000"
        required
        value={context.draft["deadlineBlock"] ?? ""}
      />
    </div>
  );
}

function DeadlineFunding(context: SetupStepRenderContext) {
  const session = useWalletSession();
  const ownerAddress = session.address ?? "No testnet wallet connected";
  return (
    <div className="setup-step__group">
      <div>
        <h2>Funding and recovery</h2>
        <p>
          The reward is reserved for one successful finalization. Your wallet retains recovery
          control.
        </p>
      </div>
      <TextField
        {...error(context, "rewardCkb")}
        hint="At least 61 CKB so the executor reward can be paid as a valid output."
        inputMode="decimal"
        label="Executor reward (CKB)"
        name="rewardCkb"
        onChange={(event) => context.setField("rewardCkb", event.target.value)}
        required
        value={context.draft["rewardCkb"] ?? ""}
      />
      <ReadonlyField
        code
        error={context.errors["ownerAddress"]}
        label="Cancellation and recovery wallet"
        name="ownerAddress"
      >
        {ownerAddress}
      </ReadonlyField>
      {session.status === "ready" ? (
        <InlineNotice title="Owner path confirmed" tone="success">
          <p>
            {session.walletName ?? "Connected wallet"}: {shortenCkbAddress(ownerAddress)}. Only a
            transaction authorized by this lock can cancel or recover the automation.
          </p>
        </InlineNotice>
      ) : (
        <InlineNotice title="Recovery wallet required" tone="warning">
          <p>Connect a supported CKB testnet wallet before continuing.</p>
          <Button
            icon={<WalletCards aria-hidden="true" size={17} />}
            name="ownerAddress"
            onClick={session.open}
            tone="secondary"
          >
            Connect wallet
          </Button>
        </InlineNotice>
      )}
    </div>
  );
}

function DeadlineStep({
  context,
  onReviewStateChange,
  onSubmissionStateChange,
  reviewState,
}: Readonly<{
  context: SetupStepRenderContext;
  onReviewStateChange: (state: CreationReviewState) => void;
  onSubmissionStateChange: (state: CreationSubmissionState) => void;
  reviewState: CreationReviewState;
}>) {
  if (context.step === "details") return <DeadlineDetails {...context} />;
  if (context.step === "timing") return <DeadlineTiming {...context} />;
  if (context.step === "funding") return <DeadlineFunding {...context} />;
  if (context.step === "review") {
    return (
      <CreationReview
        draft={context.draft}
        onStateChange={onReviewStateChange}
        template="deadline"
      />
    );
  }
  if (context.step === "approval") {
    return (
      <CreationApproval
        draft={context.draft}
        onStateChange={onSubmissionStateChange}
        reviewState={reviewState}
        template="deadline"
      />
    );
  }
  return <CreationSubmissionResult template="deadline" />;
}

export function DeadlineSetup() {
  const session = useWalletSession();
  const [reviewState, setReviewState] = useState<CreationReviewState>({ key: "", status: "idle" });
  const [submissionState, setSubmissionState] = useState<CreationSubmissionState>({
    key: "",
    status: "idle",
  });
  const onReviewStateChange = useCallback(
    (state: CreationReviewState) => setReviewState(state),
    [],
  );
  const onSubmissionStateChange = useCallback(
    (state: CreationSubmissionState) => setSubmissionState(state),
    [],
  );
  const validationContext: DeadlineValidationContext = {
    ownerLockHash: session.ownerLockHash,
    resolveLockHash: session.resolveLockHash,
    walletReady: session.status === "ready",
  };

  return (
    <SetupStepper
      initialDraft={DEADLINE_INITIAL_DRAFT}
      renderStep={(context) => (
        <DeadlineStep
          context={context}
          onReviewStateChange={onReviewStateChange}
          onSubmissionStateChange={onSubmissionStateChange}
          reviewState={reviewState}
        />
      )}
      template="deadline"
      validateStep={(step, draft) => {
        if (step === "review") {
          const message = reviewStateError(
            reviewState,
            creationReviewKey("deadline", draft, session.ownerLockHash),
          );
          return message === undefined ? {} : { review: message };
        }
        if (step === "approval") {
          const message = submissionStateError(
            submissionState,
            creationReviewKey("deadline", draft, session.ownerLockHash),
          );
          return message === undefined ? {} : { approval: message };
        }
        return validateDeadlineStep(step, draft, validationContext);
      }}
    />
  );
}
