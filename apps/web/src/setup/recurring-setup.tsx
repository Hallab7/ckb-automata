"use client";

import { WalletCards } from "lucide-react";
import { useCallback, useState } from "react";

import { Button, InlineNotice, TextField } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { shortenCkbAddress } from "../ccc/wallet-display.ts";
import { shannonsToCkb } from "./ckb-amount.ts";
import {
  RECURRING_INITIAL_DRAFT,
  recurringFundingPreview,
  validateRecurringStep,
  type RecurringFundingPreview,
  type RecurringValidationContext,
} from "./recurring-form.ts";
import type { SetupStepRenderContext } from "./setup-stepper.tsx";
import { SetupStepper } from "./setup-stepper.tsx";
import { ReadonlyField } from "./readonly-field.tsx";
import {
  CreationReview,
  creationReviewKey,
  reviewStateError,
  type CreationReviewState,
} from "./creation-review.tsx";

function error(context: SetupStepRenderContext, name: string) {
  const message = context.errors[name];
  return message === undefined ? {} : { error: message };
}

function RecurringDetails(context: SetupStepRenderContext) {
  return (
    <div className="setup-step__group">
      <div>
        <h2>Payment details</h2>
        <p>Every eligible run pays this fixed amount to one CKB testnet recipient.</p>
      </div>
      <div className="setup-form-grid">
        <TextField
          {...error(context, "recipientAddress")}
          autoComplete="off"
          hint="The recipient cannot change after wallet approval."
          label="Payment recipient"
          name="recipientAddress"
          onChange={(event) => context.setField("recipientAddress", event.target.value)}
          placeholder="ckt1..."
          required
          value={context.draft["recipientAddress"] ?? ""}
        />
        <TextField
          {...error(context, "amountCkb")}
          hint="At least 61 CKB so every payment is a valid output."
          inputMode="decimal"
          label="Amount per run (CKB)"
          name="amountCkb"
          onChange={(event) => context.setField("amountCkb", event.target.value)}
          placeholder="100"
          required
          value={context.draft["amountCkb"] ?? ""}
        />
      </div>
    </div>
  );
}

function RecurringTiming(context: SetupStepRenderContext) {
  return (
    <div className="setup-step__group">
      <div>
        <h2>Payment schedule</h2>
        <p>Each execution becomes eligible at a fixed absolute block interval.</p>
      </div>
      <div className="setup-form-grid setup-form-grid--three">
        <TextField
          {...error(context, "firstExecutionBlock")}
          hint="Use a future CKB Pudge Testnet block."
          inputMode="numeric"
          label="First execution block"
          name="firstExecutionBlock"
          onChange={(event) => context.setField("firstExecutionBlock", event.target.value)}
          placeholder="15000000"
          required
          value={context.draft["firstExecutionBlock"] ?? ""}
        />
        <TextField
          {...error(context, "intervalBlocks")}
          hint="The number of blocks between eligible payments."
          inputMode="numeric"
          label="Interval (blocks)"
          name="intervalBlocks"
          onChange={(event) => context.setField("intervalBlocks", event.target.value)}
          placeholder="100"
          required
          value={context.draft["intervalBlocks"] ?? ""}
        />
        <TextField
          {...error(context, "runCount")}
          hint="How many fixed payments the automation will make."
          inputMode="numeric"
          label="Number of runs"
          name="runCount"
          onChange={(event) => context.setField("runCount", event.target.value)}
          placeholder="3"
          required
          value={context.draft["runCount"] ?? ""}
        />
      </div>
    </div>
  );
}

function FundingPreview({ preview }: Readonly<{ preview: RecurringFundingPreview }>) {
  return (
    <div className="setup-funding-preview" aria-label="Recurring funding preview">
      <h3>Total locked value</h3>
      <dl>
        <div>
          <dt>Payments</dt>
          <dd>{shannonsToCkb(preview.payoutTotal)} CKB</dd>
        </div>
        <div>
          <dt>Executor rewards</dt>
          <dd>{shannonsToCkb(preview.rewardTotal)} CKB</dd>
        </div>
        <div>
          <dt>Job cell capacity</dt>
          <dd>{shannonsToCkb(preview.occupiedCapacity)} CKB</dd>
        </div>
        <div className="setup-funding-preview__total">
          <dt>Locked at approval</dt>
          <dd>{preview.totalLockedCkb} CKB</dd>
        </div>
      </dl>
    </div>
  );
}

function RecurringFunding(context: SetupStepRenderContext) {
  const session = useWalletSession();
  const ownerAddress = session.address ?? "No testnet wallet connected";
  let preview: RecurringFundingPreview | undefined;
  try {
    preview = recurringFundingPreview(context.draft);
  } catch {
    preview = undefined;
  }
  const insufficient =
    preview !== undefined &&
    session.balanceShannons !== undefined &&
    session.balanceShannons < preview.totalLocked;
  return (
    <div className="setup-step__group">
      <div>
        <h2>Funding and final refund</h2>
        <p>Fund every payment and reward now. Unspent job cell capacity returns to the owner.</p>
      </div>
      <TextField
        {...error(context, "rewardCkb")}
        hint="This fixed reward is reserved for each successful run."
        inputMode="decimal"
        label="Executor reward per run (CKB)"
        name="rewardCkb"
        onChange={(event) => context.setField("rewardCkb", event.target.value)}
        required
        value={context.draft["rewardCkb"] ?? ""}
      />
      {preview === undefined ? null : <FundingPreview preview={preview} />}
      <ReadonlyField
        code
        error={context.errors["ownerAddress"]}
        label="Funding and refund wallet"
        name="ownerAddress"
      >
        {ownerAddress}
      </ReadonlyField>
      <ReadonlyField label="Final refund" name="finalRefund">
        Remaining job cell capacity returns to the connected owner wallet
      </ReadonlyField>
      {session.status === "ready" ? (
        <InlineNotice
          title={insufficient ? "More testnet CKB required" : "Owner refund path confirmed"}
          tone={insufficient ? "danger" : "success"}
        >
          <p>
            {session.walletName ?? "Connected wallet"}: {shortenCkbAddress(ownerAddress)}
            {session.balanceShannons === undefined
              ? ". Balance is loading."
              : ` with ${shannonsToCkb(session.balanceShannons)} CKB available.`}
          </p>
        </InlineNotice>
      ) : (
        <InlineNotice title="Funding wallet required" tone="warning">
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

function RecurringStep({
  context,
  onReviewStateChange,
}: Readonly<{
  context: SetupStepRenderContext;
  onReviewStateChange: (state: CreationReviewState) => void;
}>) {
  if (context.step === "details") return <RecurringDetails {...context} />;
  if (context.step === "timing") return <RecurringTiming {...context} />;
  if (context.step === "funding") return <RecurringFunding {...context} />;
  if (context.step === "review") {
    return (
      <CreationReview
        draft={context.draft}
        onStateChange={onReviewStateChange}
        template="recurring"
      />
    );
  }
  const title =
    context.step === "approval" ? "Wallet approval pending" : "No transaction submitted";
  return (
    <div className="setup-step__empty">
      <h2>{title}</h2>
      <p>The recurring parameters are saved in this browser session.</p>
    </div>
  );
}

export function RecurringSetup() {
  const session = useWalletSession();
  const [reviewState, setReviewState] = useState<CreationReviewState>({ key: "", status: "idle" });
  const onReviewStateChange = useCallback(
    (state: CreationReviewState) => setReviewState(state),
    [],
  );
  const validationContext: RecurringValidationContext = {
    balanceShannons: session.balanceShannons,
    ownerLockHash: session.ownerLockHash,
    resolveLockHash: session.resolveLockHash,
    walletReady: session.status === "ready",
  };
  return (
    <SetupStepper
      initialDraft={RECURRING_INITIAL_DRAFT}
      renderStep={(context) => (
        <RecurringStep context={context} onReviewStateChange={onReviewStateChange} />
      )}
      template="recurring"
      validateStep={(step, draft) => {
        if (step === "review") {
          const message = reviewStateError(
            reviewState,
            creationReviewKey("recurring", draft, session.ownerLockHash),
          );
          return message === undefined ? {} : { review: message };
        }
        return validateRecurringStep(step, draft, validationContext);
      }}
    />
  );
}
