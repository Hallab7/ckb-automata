import type { DeadLetterPayload } from "./queues.ts";

export type DaoHarvestOperationalEvent =
  | "prepare_ready"
  | "prepare_missed"
  | "claim_ready"
  | "transition_confirmed"
  | "budget_low"
  | "budget_exhausted"
  | "reorged"
  | "rpc_unavailable"
  | "deprecated";

export interface DaoHarvestOperationalSignal {
  readonly notificationType: "ready" | "confirmed" | "failed" | "budget_low" | "recovery_required";
  readonly title: string;
  readonly message: string;
  readonly alertSeverity: "warning" | "critical" | null;
  readonly metricOutcome: "ready" | "confirmed" | "failed" | "reorged";
  readonly ownerActionRequired: boolean;
}

const SIGNALS = Object.freeze({
  prepare_ready: {
    notificationType: "ready",
    title: "Withdrawal preparation is ready",
    message: "An executor can prepare this DAO withdrawal during the current window.",
    alertSeverity: null,
    metricOutcome: "ready",
    ownerActionRequired: false,
  },
  prepare_missed: {
    notificationType: "failed",
    title: "Withdrawal window was missed",
    message: "No funds moved. The automation will wait for the next available DAO cycle.",
    alertSeverity: "critical",
    metricOutcome: "failed",
    ownerActionRequired: false,
  },
  claim_ready: {
    notificationType: "ready",
    title: "DAO funds are ready to claim",
    message: "An executor can now claim the compensation and redeposit the original amount.",
    alertSeverity: null,
    metricOutcome: "ready",
    ownerActionRequired: false,
  },
  transition_confirmed: {
    notificationType: "confirmed",
    title: "DAO action completed",
    message: "The latest DAO action is confirmed on CKB.",
    alertSeverity: null,
    metricOutcome: "confirmed",
    ownerActionRequired: false,
  },
  budget_low: {
    notificationType: "budget_low",
    title: "Automation balance is running low",
    message: "Add funds to keep future DAO actions running.",
    alertSeverity: "warning",
    metricOutcome: "failed",
    ownerActionRequired: true,
  },
  budget_exhausted: {
    notificationType: "recovery_required",
    title: "Automation balance is empty",
    message: "Future actions are stopped. You can independently exit with your wallet.",
    alertSeverity: "critical",
    metricOutcome: "failed",
    ownerActionRequired: true,
  },
  reorged: {
    notificationType: "recovery_required",
    title: "Chain history changed",
    message: "This automation needs a fresh chain check before it can continue.",
    alertSeverity: "critical",
    metricOutcome: "reorged",
    ownerActionRequired: true,
  },
  rpc_unavailable: {
    notificationType: "failed",
    title: "CKB connection is unavailable",
    message: "No funds moved. Execution will retry after the public chain connection recovers.",
    alertSeverity: "warning",
    metricOutcome: "failed",
    ownerActionRequired: false,
  },
  deprecated: {
    notificationType: "recovery_required",
    title: "This automation version is retired",
    message: "Use the recovery tool with your wallet to stop or exit this automation.",
    alertSeverity: "critical",
    metricOutcome: "failed",
    ownerActionRequired: true,
  },
} as const satisfies Readonly<Record<DaoHarvestOperationalEvent, DaoHarvestOperationalSignal>>);

export function daoHarvestOperationalSignal(
  event: DaoHarvestOperationalEvent,
): DaoHarvestOperationalSignal {
  return SIGNALS[event];
}

export interface DaoHarvestDeadLetterInspection {
  readonly applies: boolean;
  readonly recommendation: "replay" | "pause_and_inspect" | "owner_recovery" | "not_applicable";
  readonly reason: string;
}

export function inspectDaoHarvestDeadLetter(
  record: Readonly<{
    payload: Pick<DeadLetterPayload, "failureCode" | "sourceOperation">;
  }>,
): DaoHarvestDeadLetterInspection {
  const { failureCode, sourceOperation } = record.payload;
  if (!sourceOperation.startsWith("dao-harvest-")) {
    return Object.freeze({
      applies: false,
      recommendation: "not_applicable",
      reason: "The failed work is not a DAO harvest operation.",
    });
  }
  if (/DEPRECATED|BUDGET_EXHAUSTED|WINDOW_MISSED/.test(failureCode)) {
    return Object.freeze({
      applies: true,
      recommendation: "owner_recovery",
      reason:
        "Do not replay. Confirm chain state and give the owner the independent recovery path.",
    });
  }
  if (/SCRIPT|INVALID|PRINCIPAL|PAYOUT/.test(failureCode)) {
    return Object.freeze({
      applies: true,
      recommendation: "pause_and_inspect",
      reason: "Pause new work and compare the transaction with the committed DAO intent.",
    });
  }
  return Object.freeze({
    applies: true,
    recommendation: "replay",
    reason: "Re-check the public chain state, then replay once the dependency has recovered.",
  });
}
