import type { CanonicalTransactionState } from "@ckb-automata/core";

export const TRANSACTION_STATE_LABELS = {
  draft: "Draft",
  awaiting_signature: "Awaiting signature",
  submitted: "Submitted",
  proposed: "Proposed",
  committed: "Committed",
  confirmed: "Confirmed",
  conflicted: "Conflicted",
  dropped: "Dropped",
  cancelled: "Cancelled",
  recovery_required: "Recovery required",
  reorged: "Reorganized",
} as const satisfies Record<CanonicalTransactionState, string>;
