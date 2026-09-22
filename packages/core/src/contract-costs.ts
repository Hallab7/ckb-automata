import benchmarkReport from "../../../contracts/benchmarks.json" with { type: "json" };

export type ContractCapacityId = "plain-wallet-cell" | "job-cell-v1" | "campaign-cell-v1";

function measuredCapacity(id: ContractCapacityId): bigint {
  const measurement = benchmarkReport.capacities.find((entry) => entry.id === id);
  if (!measurement) {
    throw new Error(`missing contract capacity measurement: ${id}`);
  }
  return BigInt(measurement.occupiedShannons);
}

export const CONTRACT_CAPACITY = {
  plainWalletCell: measuredCapacity("plain-wallet-cell"),
  jobCellV1: measuredCapacity("job-cell-v1"),
  campaignCellV1: measuredCapacity("campaign-cell-v1"),
} as const;

export function minimumJobCellCapacity(spendableBudget: bigint): bigint {
  if (spendableBudget < 0n) {
    throw new RangeError("spendableBudget must not be negative");
  }
  return CONTRACT_CAPACITY.jobCellV1 + spendableBudget;
}

export function minimumCampaignCellCapacity(pledged: bigint): bigint {
  if (pledged < 0n) {
    throw new RangeError("pledged must not be negative");
  }
  return CONTRACT_CAPACITY.campaignCellV1 + pledged;
}
