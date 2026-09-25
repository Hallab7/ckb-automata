export interface ReviewedChainWindow {
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly expiresAfterBlock?: string;
}

function blockNumber(value: string, name: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} is not a canonical block number.`);
  }
  return BigInt(value);
}

export function assertCanonicalReviewWindow(
  reviewed: ReviewedChainWindow,
  currentBlock: bigint,
  canonicalHash: string | undefined,
): void {
  const snapshotBlock = blockNumber(reviewed.blockNumber, "The reviewed snapshot block");
  const expiresAfterBlock = blockNumber(
    reviewed.expiresAfterBlock ?? reviewed.blockNumber,
    "The reviewed expiry block",
  );
  if (expiresAfterBlock < snapshotBlock) {
    throw new Error("The reviewed chain snapshot has an invalid expiry. Build a fresh review.");
  }
  if (currentBlock < snapshotBlock || currentBlock > expiresAfterBlock) {
    throw new Error("The reviewed chain snapshot expired. Build a fresh review.");
  }
  if (canonicalHash !== reviewed.blockHash) {
    throw new Error("The reviewed chain snapshot is no longer canonical. Build a fresh review.");
  }
}
