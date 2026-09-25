import benchmarkReport from "../../../contracts/benchmarks.json" with { type: "json" };

import { parseShannons, type Shannons } from "./chain-values.ts";
import type { ScriptIdentity } from "./job-inspection.ts";

export type ContractCapacityId = "plain-wallet-cell" | "job-cell-v1" | "campaign-cell-v1";

function measuredCapacity(id: ContractCapacityId): Shannons {
  const measurement = benchmarkReport.capacities.find((entry) => entry.id === id);
  if (!measurement) {
    throw new Error(`missing contract capacity measurement: ${id}`);
  }
  return parseShannons(measurement.occupiedShannons);
}

export const CONTRACT_CAPACITY = {
  plainWalletCell: measuredCapacity("plain-wallet-cell"),
  jobCellV1: measuredCapacity("job-cell-v1"),
  campaignCellV1: measuredCapacity("campaign-cell-v1"),
} as const;

const SHANNONS_PER_CKB = 100_000_000n;

export function minimumPlainCellCapacity(lock: ScriptIdentity): Shannons {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(lock.args)) {
    throw new TypeError("lock args must be canonical lowercase byte hex");
  }
  const argsBytes = (lock.args.length - 2) / 2;
  return parseShannons(BigInt(8 + 33 + argsBytes) * SHANNONS_PER_CKB);
}

export function minimumJobCellCapacity(spendableBudget: Shannons): Shannons {
  return parseShannons(CONTRACT_CAPACITY.jobCellV1 + spendableBudget);
}

export function minimumCampaignCellCapacity(pledged: Shannons): Shannons {
  return parseShannons(CONTRACT_CAPACITY.campaignCellV1 + pledged);
}
