import { and, desc, eq, gt, lt, sql } from "drizzle-orm";

import { parseBlockNumber, parseHash32, type BlockNumber, type Hash32 } from "@ckb-automata/core";

import type { AutomataDatabase } from "../database/client.ts";
import { canonicalBlocks, indexerCheckpoints } from "../database/schema.ts";

export const DEFAULT_CANONICAL_ROLLBACK_WINDOW = 128;

export type CheckpointErrorCode =
  "INVALID_NETWORK" | "NON_CONTIGUOUS_BLOCK" | "REORG_BEYOND_WINDOW";

export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;

  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

export interface CanonicalPosition {
  readonly blockNumber: BlockNumber;
  readonly blockHash: Hash32;
}

export interface CanonicalBlockInput extends CanonicalPosition {
  readonly networkId: string;
  readonly parentHash: Hash32;
  readonly blockTimestamp: bigint;
}

export interface CheckpointUpdate {
  readonly status: "initialized" | "advanced" | "unchanged" | "reorganized";
  readonly checkpoint: CanonicalPosition;
  readonly rolledBackBlocks: number;
}

interface TransitionContext {
  readonly current?: CanonicalPosition;
  readonly existingAtHeight?: CanonicalPosition;
  readonly parentInWindow?: CanonicalPosition;
  readonly incoming: CanonicalBlockInput;
}

interface TransitionPlan {
  readonly status: CheckpointUpdate["status"];
  readonly rolledBackBlocks: number;
  readonly rollbackAfter?: BlockNumber;
}

function assertNetworkId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new CheckpointError("INVALID_NETWORK", "networkId must be a stable lowercase identifier");
  }
  return value;
}

function rollbackCount(current: BlockNumber, ancestor: BlockNumber): number {
  const count = current - ancestor;
  if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CheckpointError("REORG_BEYOND_WINDOW", "canonical rollback count is unsafe");
  }
  return Number(count);
}

export function planCheckpointTransition(context: TransitionContext): TransitionPlan {
  const { current, existingAtHeight, incoming, parentInWindow } = context;
  if (existingAtHeight?.blockHash === incoming.blockHash) {
    return Object.freeze({ status: "unchanged", rolledBackBlocks: 0 });
  }
  if (!current) return Object.freeze({ status: "initialized", rolledBackBlocks: 0 });
  if (
    incoming.blockNumber === current.blockNumber + 1n &&
    incoming.parentHash === current.blockHash
  ) {
    return Object.freeze({ status: "advanced", rolledBackBlocks: 0 });
  }
  if (
    parentInWindow &&
    parentInWindow.blockHash === incoming.parentHash &&
    parentInWindow.blockNumber + 1n === incoming.blockNumber &&
    parentInWindow.blockNumber < current.blockNumber
  ) {
    return Object.freeze({
      status: "reorganized",
      rolledBackBlocks: rollbackCount(current.blockNumber, parentInWindow.blockNumber),
      rollbackAfter: parentInWindow.blockNumber,
    });
  }
  const code =
    incoming.blockNumber <= current.blockNumber ? "REORG_BEYOND_WINDOW" : "NON_CONTIGUOUS_BLOCK";
  throw new CheckpointError(code, "incoming block does not extend the retained canonical chain");
}

function position(row: { blockNumber: string; blockHash: string }): CanonicalPosition {
  return Object.freeze({
    blockNumber: parseBlockNumber(row.blockNumber),
    blockHash: parseHash32(row.blockHash),
  });
}

export class CanonicalCheckpointStore {
  readonly #database: AutomataDatabase;
  readonly #rollbackWindow: number;

  constructor(
    database: AutomataDatabase,
    rollbackWindow: number = DEFAULT_CANONICAL_ROLLBACK_WINDOW,
  ) {
    if (!Number.isSafeInteger(rollbackWindow) || rollbackWindow < 2) {
      throw new RangeError("rollbackWindow must be a safe integer of at least 2");
    }
    this.#database = database;
    this.#rollbackWindow = rollbackWindow;
  }

  async load(networkIdValue: string): Promise<CanonicalPosition | undefined> {
    const networkId = assertNetworkId(networkIdValue);
    const [row] = await this.#database
      .select({
        blockNumber: indexerCheckpoints.blockNumber,
        blockHash: indexerCheckpoints.blockHash,
      })
      .from(indexerCheckpoints)
      .where(eq(indexerCheckpoints.networkId, networkId))
      .limit(1);
    return row ? position(row) : undefined;
  }

  async listRetained(networkIdValue: string): Promise<readonly CanonicalPosition[]> {
    const networkId = assertNetworkId(networkIdValue);
    const rows = await this.#database
      .select({
        blockNumber: canonicalBlocks.blockNumber,
        blockHash: canonicalBlocks.blockHash,
      })
      .from(canonicalBlocks)
      .where(eq(canonicalBlocks.networkId, networkId))
      .orderBy(desc(canonicalBlocks.blockNumber));
    return Object.freeze(rows.map(position));
  }

  async record(input: CanonicalBlockInput): Promise<CheckpointUpdate> {
    const block: CanonicalBlockInput = Object.freeze({
      networkId: assertNetworkId(input.networkId),
      blockNumber: parseBlockNumber(input.blockNumber),
      blockHash: parseHash32(input.blockHash),
      parentHash: parseHash32(input.parentHash),
      blockTimestamp: parseBlockNumber(input.blockTimestamp),
    });

    return this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${block.networkId}, 0))`,
      );
      const [checkpointRow] = await transaction
        .select({
          blockNumber: indexerCheckpoints.blockNumber,
          blockHash: indexerCheckpoints.blockHash,
        })
        .from(indexerCheckpoints)
        .where(eq(indexerCheckpoints.networkId, block.networkId))
        .for("update")
        .limit(1);
      const [existingRow] = await transaction
        .select({
          blockNumber: canonicalBlocks.blockNumber,
          blockHash: canonicalBlocks.blockHash,
        })
        .from(canonicalBlocks)
        .where(
          and(
            eq(canonicalBlocks.networkId, block.networkId),
            eq(canonicalBlocks.blockNumber, block.blockNumber.toString()),
          ),
        )
        .limit(1);
      const [parentRow] = await transaction
        .select({
          blockNumber: canonicalBlocks.blockNumber,
          blockHash: canonicalBlocks.blockHash,
        })
        .from(canonicalBlocks)
        .where(
          and(
            eq(canonicalBlocks.networkId, block.networkId),
            eq(canonicalBlocks.blockHash, block.parentHash),
          ),
        )
        .limit(1);
      const current = checkpointRow ? position(checkpointRow) : undefined;
      const plan = planCheckpointTransition({
        ...(current ? { current } : {}),
        ...(existingRow ? { existingAtHeight: position(existingRow) } : {}),
        ...(parentRow ? { parentInWindow: position(parentRow) } : {}),
        incoming: block,
      });

      if (plan.status === "unchanged") {
        if (!current) throw new Error("canonical block exists without a checkpoint");
        return Object.freeze({ status: plan.status, checkpoint: current, rolledBackBlocks: 0 });
      }
      if (plan.rollbackAfter !== undefined) {
        await transaction
          .delete(canonicalBlocks)
          .where(
            and(
              eq(canonicalBlocks.networkId, block.networkId),
              gt(canonicalBlocks.blockNumber, plan.rollbackAfter.toString()),
            ),
          );
      }

      await transaction.insert(canonicalBlocks).values({
        networkId: block.networkId,
        blockNumber: block.blockNumber.toString(),
        blockHash: block.blockHash,
        parentHash: block.parentHash,
        blockTimestamp: block.blockTimestamp.toString(),
      });
      await transaction
        .insert(indexerCheckpoints)
        .values({
          networkId: block.networkId,
          blockNumber: block.blockNumber.toString(),
          blockHash: block.blockHash,
        })
        .onConflictDoUpdate({
          target: indexerCheckpoints.networkId,
          set: {
            blockNumber: block.blockNumber.toString(),
            blockHash: block.blockHash,
            updatedAt: new Date(),
          },
        });

      const pruneBefore = block.blockNumber - BigInt(this.#rollbackWindow) + 1n;
      if (pruneBefore > 0n) {
        await transaction
          .delete(canonicalBlocks)
          .where(
            and(
              eq(canonicalBlocks.networkId, block.networkId),
              lt(canonicalBlocks.blockNumber, pruneBefore.toString()),
            ),
          );
      }
      return Object.freeze({
        status: plan.status,
        checkpoint: Object.freeze({
          blockNumber: block.blockNumber,
          blockHash: block.blockHash,
        }),
        rolledBackBlocks: plan.rolledBackBlocks,
      });
    });
  }
}
