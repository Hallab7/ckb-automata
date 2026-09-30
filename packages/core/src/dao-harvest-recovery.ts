export type DaoHarvestRecoveryCondition =
  "normal" | "budget_exhausted" | "deprecated" | "service_unavailable";

export interface DaoHarvestRecoveryStatus {
  readonly condition: DaoHarvestRecoveryCondition;
  readonly vaultState: "deposited" | "withdrawing";
  readonly claimMature: boolean;
}

export type DaoHarvestOwnerAction =
  "stop_recurrence" | "start_owner_exit" | "wait_for_maturity" | "claim_mature_vault";

export interface DaoHarvestRecoveryPlan {
  readonly primaryAction: DaoHarvestOwnerAction;
  readonly availableActions: readonly DaoHarvestOwnerAction[];
  readonly hostedServicesRequired: false;
  readonly preservesPrincipal: true;
  readonly explanation: string;
}

export function planDaoHarvestRecovery(status: DaoHarvestRecoveryStatus): DaoHarvestRecoveryPlan {
  if (
    !["normal", "budget_exhausted", "deprecated", "service_unavailable"].includes(status.condition)
  ) {
    throw new TypeError("DAO harvest recovery condition is unsupported");
  }
  if (status.vaultState === "deposited") {
    return Object.freeze({
      primaryAction: "start_owner_exit",
      availableActions: Object.freeze(["stop_recurrence", "start_owner_exit"] as const),
      hostedServicesRequired: false,
      preservesPrincipal: true,
      explanation:
        "Start the owner exit. The DAO deposit becomes withdrawing and remains subject to DAO maturity before the final claim.",
    });
  }
  if (status.claimMature) {
    return Object.freeze({
      primaryAction: "claim_mature_vault",
      availableActions: Object.freeze(["claim_mature_vault"] as const),
      hostedServicesRequired: false,
      preservesPrincipal: true,
      explanation:
        "Claim the mature withdrawing vault directly to the owner wallet. CKAutomata services are not required.",
    });
  }
  return Object.freeze({
    primaryAction: "wait_for_maturity",
    availableActions: Object.freeze(["wait_for_maturity"] as const),
    hostedServicesRequired: false,
    preservesPrincipal: true,
    explanation:
      "The DAO withdrawal is not mature yet. Wait for its exact claim epoch, then claim it directly to the owner wallet.",
  });
}
