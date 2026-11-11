import type { ApiDaoHarvestV3Build } from "@ckb-automata/api-client";
import {
  CREATION_REVIEW_WINDOW_BLOCKS,
  parseHash32,
  parseShannons,
  verifyCompletedDaoHarvestV3Transaction,
  type DaoHarvestV3Build,
  type ResolvedDaoHarvestV3FundingInput,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

interface ReviewInputResolver {
  readonly resolveReviewInput: (
    input: UnsignedDeadlineTransaction["inputs"][number],
  ) => Promise<{ readonly capacity: bigint; readonly lockHash: string }>;
}

const OPERATION = Object.freeze({
  setup: 0,
  "preferred-prepare": 1,
  "fallback-prepare": 2,
  "preferred-claim": 3,
  "fallback-claim": 4,
  "owner-complete": 5,
  sweep: 6,
  close: 7,
  rotate: 8,
  "owner-exit": 9,
  "owner-recovery": 10,
} as const);

function manifestDigest(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("The reviewed V3 deployment manifest is invalid.");
  }
  return value;
}

export function verifyDaoHarvestV3SignerChain(
  build: Pick<ApiDaoHarvestV3Build, "chain">,
  signerGenesisValue: string,
  expectedGenesisValue: string,
): void {
  const signerGenesis = parseHash32(signerGenesisValue);
  const expectedGenesis = parseHash32(expectedGenesisValue);
  const reviewedGenesis = parseHash32(build.chain.genesisHash);
  manifestDigest(build.chain.manifestSha256);
  if (signerGenesis !== expectedGenesis || reviewedGenesis !== expectedGenesis) {
    throw new Error("The connected wallet is not using the reviewed CKB testnet deployment.");
  }
}

function transaction(value: unknown): UnsignedDeadlineTransaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The reviewed transaction is invalid.");
  }
  const item = value as Record<string, unknown>;
  for (const field of ["cellDeps", "headerDeps", "inputs", "outputs", "outputsData", "witnesses"]) {
    if (!Array.isArray(item[field])) throw new Error("The reviewed transaction is incomplete.");
  }
  if (typeof item["version"] !== "string") {
    throw new Error("The reviewed transaction version is invalid.");
  }
  return value as UnsignedDeadlineTransaction;
}

export function normalizeDaoHarvestV3Build(build: ApiDaoHarvestV3Build): DaoHarvestV3Build {
  const operation = OPERATION[build.operation as keyof typeof OPERATION];
  if (operation === undefined) throw new Error("The reviewed harvest action is unsupported.");
  const completion = build.completion;
  return Object.freeze({
    operation,
    transaction: transaction(build.transaction),
    intentHash: parseHash32(build.intentHash),
    value: Object.freeze({
      totalInput: parseShannons(build.review.totalInput),
      totalOutput: parseShannons(build.review.totalOutput),
      maximumNetworkFee: parseShannons(build.review.maximumNetworkFee),
    }),
    completion: Object.freeze({
      requiredInputCount: completion.requiredInputCount,
      requiredOutputCount: completion.requiredOutputCount,
      requiredInputCapacity: parseShannons(completion.requiredInputCapacity),
      maximumFee: parseShannons(completion.maximumFee),
      allowedFundingLockHashes: Object.freeze(completion.allowedFundingLockHashes.map(parseHash32)),
      ...(completion.protectedSameIndex === undefined
        ? {}
        : { protectedSameIndex: completion.protectedSameIndex }),
    }),
  });
}

export async function verifyCompletedDaoHarvestV3Review(
  build: ApiDaoHarvestV3Build,
  completed: UnsignedDeadlineTransaction,
  resolver: ReviewInputResolver,
): Promise<void> {
  const normalized = normalizeDaoHarvestV3Build(build);
  const added = completed.inputs.slice(normalized.completion.requiredInputCount);
  const fundingInputs: ResolvedDaoHarvestV3FundingInput[] = await Promise.all(
    added.map(async (input) => {
      const resolved = await resolver.resolveReviewInput(input);
      return Object.freeze({
        outPoint: input.previousOutput,
        capacity: resolved.capacity,
        lockHash: parseHash32(resolved.lockHash),
      });
    }),
  );
  verifyCompletedDaoHarvestV3Transaction(normalized, completed, fundingInputs);
}

export function verifyRefreshedDaoHarvestV3Build(
  reviewed: ApiDaoHarvestV3Build,
  refreshed: ApiDaoHarvestV3Build,
): void {
  if (
    reviewed.version !== refreshed.version ||
    reviewed.jobId !== refreshed.jobId ||
    reviewed.operation !== refreshed.operation ||
    reviewed.intentHash !== refreshed.intentHash ||
    reviewed.chain.genesisHash !== refreshed.chain.genesisHash ||
    reviewed.chain.manifestSha256 !== refreshed.chain.manifestSha256
  ) {
    throw new Error("The harvest review changed. Build a fresh review before signing.");
  }
}

export function daoHarvestV3ReviewSnapshot(
  tip: Readonly<{ blockHash: string; blockNumber: string }>,
  chain: ApiDaoHarvestV3Build["chain"],
) {
  parseHash32(tip.blockHash);
  const genesisHash = parseHash32(chain.genesisHash);
  const manifestSha256 = manifestDigest(chain.manifestSha256);
  if (!/^(?:0|[1-9][0-9]*)$/.test(tip.blockNumber)) {
    throw new Error("The reviewed snapshot block is invalid.");
  }
  return Object.freeze({
    ...tip,
    genesisHash,
    manifestSha256,
    expiresAfterBlock: (BigInt(tip.blockNumber) + CREATION_REVIEW_WINDOW_BLOCKS).toString(),
  });
}
