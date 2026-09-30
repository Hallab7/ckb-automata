import type { ApiDaoHarvest } from "@ckb-automata/api-client";

export type DaoHarvestStatus = "completed" | "processing" | "recovery" | "waiting";

export interface DaoHarvestPresentation {
  readonly action: string;
  readonly completedCycles: number;
  readonly status: DaoHarvestStatus;
  readonly statusLabel: string;
  readonly totalCycles: number;
}

export function daoHarvestPresentation(job: ApiDaoHarvest): DaoHarvestPresentation {
  const completedCycles = Number(job.progress.completedCycles);
  const totalCycles = Number(job.progress.totalCycles);
  if (!Number.isSafeInteger(completedCycles) || !Number.isSafeInteger(totalCycles)) {
    throw new Error("Harvest cycle progress is invalid");
  }
  if (job.state === "completed") {
    return {
      action: "All selected harvests are complete",
      completedCycles,
      status: "completed",
      statusLabel: "Completed",
      totalCycles,
    };
  }
  if (job.state === "recovery_required") {
    return {
      action: "Owner recovery is needed",
      completedCycles,
      status: "recovery",
      statusLabel: "Recovery needed",
      totalCycles,
    };
  }
  if (job.state === "withdrawing") {
    return {
      action: "Waiting for the DAO withdrawal to mature",
      completedCycles,
      status: "processing",
      statusLabel: "Processing",
      totalCycles,
    };
  }
  if (job.state === "claim_ready") {
    return {
      action: "Re-deposit and compensation payout are being prepared",
      completedCycles,
      status: "processing",
      statusLabel: "Processing",
      totalCycles,
    };
  }
  return {
    action: "Waiting for the next DAO cycle",
    completedCycles,
    status: "waiting",
    statusLabel: "Waiting",
    totalCycles,
  };
}

export function formatHarvestPrincipal(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return "Amount unavailable";
  const shannons = BigInt(value);
  const whole = shannons / 100_000_000n;
  const fraction = (shannons % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} CKB`;
}
