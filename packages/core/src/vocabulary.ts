export const CANONICAL_TERMS = [
  "job",
  "policy",
  "trigger",
  "action",
  "successor",
  "reward",
  "cancellation",
  "recovery",
  "submitted",
  "committed",
  "confirmed",
] as const;

export type CanonicalTerm = (typeof CANONICAL_TERMS)[number];

export const GLOSSARY = {
  job: "A funded CKB cell carrying one automation intent and its policy commitment.",
  policy: "The on-chain rules that authorize an action and constrain its outputs.",
  trigger:
    "Chain-observable evidence that makes a policy action eligible; a server clock is only a wake-up hint.",
  action: "An authorized transaction transition that consumes a live job.",
  successor: "The single constrained job output created by a recurring action for its next run.",
  reward: "The fixed amount committed by a job and paid atomically to the eligible executor.",
  cancellation:
    "An owner-authorized normal close of a supported live job that pays no executor reward.",
  recovery:
    "An owner-authorized escape from an unsupported, invalid, or stalled job that pays no executor reward.",
  submitted:
    "Accepted by a CKB node RPC for relay or pool processing, but not included in a block.",
  committed:
    "Included in a currently canonical block, but below the configured confirmation depth.",
  confirmed: "Committed in the canonical chain at or beyond the configured confirmation depth.",
} as const satisfies Record<CanonicalTerm, string>;

export const CANONICAL_TRANSACTION_STATES = [
  "draft",
  "awaiting_signature",
  "submitted",
  "proposed",
  "committed",
  "confirmed",
  "conflicted",
  "dropped",
  "cancelled",
  "recovery_required",
  "reorged",
] as const;

export type CanonicalTransactionState = (typeof CANONICAL_TRANSACTION_STATES)[number];
