const HASH32 = /^0x[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface NervDaoChainIdentity {
  readonly genesisHash: string;
  readonly manifestSha256: string;
}

export interface NervDaoReviewIdentity {
  readonly version: 3;
  readonly jobId: string;
  readonly operation: string;
  readonly intentHash: string;
  readonly chain: NervDaoChainIdentity;
}

export type NervDaoOwnerAction = "owner-exit" | "owner-recovery";
export type NervDaoPositionState =
  "deposited" | "withdrawing" | "owner_withdrawing" | "completed" | "recovered" | "closed";

export const NERVDAO_HARVEST_TESTNET_NOTICE = Object.freeze({
  title: "Testnet security preview",
  body: "Use testnet funds only. DAO Harvest V3 has internal test coverage but has not completed an independent professional audit.",
});

export const NERVDAO_HARVEST_TIMING_NOTICES = Object.freeze([
  "Your preferred operator gets the first chance to start each withdrawal. Approved backup operators can take over later if it does not act.",
  "An approved operator may still start a withdrawal late until you remove it. Updating operators cannot cancel a transaction that was already submitted.",
  "If the preparation window is missed, the next opportunity is usually about 180 DAO epochs, roughly 30 days, later. CKB chain epochs decide the exact time.",
  "Stopping the automation starts a normal DAO withdrawal. Your funds remain locked until normal DAO maturity and do not become spendable immediately.",
]);

function hash32(value: string, name: string): string {
  if (!HASH32.test(value)) throw new TypeError(`${name} must be a lowercase 32-byte hash`);
  return value;
}

function digest(value: string): string {
  if (!SHA256.test(value)) throw new TypeError("manifest digest must be lowercase SHA-256");
  return value;
}

export function assertNervDaoTestnetIdentity(
  reviewed: NervDaoChainIdentity,
  signerGenesisValue: string,
  expected: NervDaoChainIdentity,
): void {
  const signerGenesis = hash32(signerGenesisValue, "signer genesis");
  const reviewedGenesis = hash32(reviewed.genesisHash, "reviewed genesis");
  const expectedGenesis = hash32(expected.genesisHash, "expected genesis");
  const reviewedManifest = digest(reviewed.manifestSha256);
  const expectedManifest = digest(expected.manifestSha256);
  if (
    signerGenesis !== expectedGenesis ||
    reviewedGenesis !== expectedGenesis ||
    reviewedManifest !== expectedManifest
  ) {
    throw new Error("the connected client does not match the approved testnet deployment");
  }
}

export function assertNervDaoReviewUnchanged(
  reviewed: NervDaoReviewIdentity,
  refreshed: NervDaoReviewIdentity,
): void {
  if (
    reviewed.version !== refreshed.version ||
    hash32(reviewed.jobId, "reviewed job") !== hash32(refreshed.jobId, "refreshed job") ||
    reviewed.operation !== refreshed.operation ||
    hash32(reviewed.intentHash, "reviewed intent") !==
      hash32(refreshed.intentHash, "refreshed intent") ||
    hash32(reviewed.chain.genesisHash, "reviewed genesis") !==
      hash32(refreshed.chain.genesisHash, "refreshed genesis") ||
    digest(reviewed.chain.manifestSha256) !== digest(refreshed.chain.manifestSha256)
  ) {
    throw new Error("the DAO Harvest review changed");
  }
}

export function nervDaoOwnerAction(
  state: NervDaoPositionState,
  hasPrepareAccumulator: boolean,
): NervDaoOwnerAction | undefined {
  if (state === "deposited") return "owner-exit";
  if (state === "withdrawing" && hasPrepareAccumulator) return "owner-recovery";
  return undefined;
}

export function nervDaoPositionLabel(
  state: NervDaoPositionState,
): "Completed" | "Processing" | "Waiting" {
  if (state === "completed" || state === "recovered" || state === "closed") return "Completed";
  if (state === "withdrawing" || state === "owner_withdrawing") return "Processing";
  return "Waiting";
}
