import { and, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";

import type { ClientBlock } from "@ckb-ccc/shell";

import {
  parseBlockNumber,
  parseHash32,
  type BlockNumber,
  type Hash32,
  type RegisteredDeployment,
} from "@ckb-automata/core";

import type { CkbReadClient } from "../ckb-client.ts";
import type { AutomataDatabase } from "../database/client.ts";
import {
  canonicalBlocks,
  indexerCheckpoints,
  jobEvents,
  jobs,
  jobVersions,
} from "../database/schema.ts";
import { CanonicalCheckpointStore, CheckpointError, type CheckpointUpdate } from "./checkpoints.ts";
import { JobCellDiscovery, type JobDiscoveryResult } from "./job-discovery.ts";
import { JobTransitionIndexer, type JobTransitionResult } from "./job-transitions.ts";

export interface ReorgRollbackResult {
  readonly rolledBackBlocks: number;
  readonly orphanedEvents: number;
  readonly orphanedVersions: number;
  readonly restoredJobs: number;
  readonly orphanedJobs: number;
  readonly checkpoint: {
    readonly blockNumber: BlockNumber;
    readonly blockHash: Hash32;
  };
}

export interface CanonicalBlockProjectionResult {
  readonly rollback?: ReorgRollbackResult;
  readonly discovery: JobDiscoveryResult;
  readonly transitions: JobTransitionResult;
  readonly checkpoint: CheckpointUpdate;
}

function networkId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new CheckpointError("INVALID_NETWORK", "networkId must be a stable lowercase identifier");
  }
  return value;
}

export class JobProjectionRollback {
  readonly #database: AutomataDatabase;

  constructor(database: AutomataDatabase) {
    this.#database = database;
  }

  async rollbackToParent(
    networkIdValue: string,
    parentNumberValue: bigint,
    parentHashValue: string,
  ): Promise<ReorgRollbackResult> {
    const targetNetwork = networkId(networkIdValue);
    const parentNumber = parseBlockNumber(parentNumberValue);
    const parentHash = parseHash32(parentHashValue);

    return this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${targetNetwork}, 0))`,
      );
      const [checkpoint] = await transaction
        .select({
          blockNumber: indexerCheckpoints.blockNumber,
          blockHash: indexerCheckpoints.blockHash,
        })
        .from(indexerCheckpoints)
        .where(eq(indexerCheckpoints.networkId, targetNetwork))
        .for("update")
        .limit(1);
      if (!checkpoint) {
        throw new CheckpointError("REORG_BEYOND_WINDOW", "cannot roll back an empty checkpoint");
      }
      const currentNumber = parseBlockNumber(checkpoint.blockNumber);
      const currentHash = parseHash32(checkpoint.blockHash);
      if (currentNumber === parentNumber && currentHash === parentHash) {
        return Object.freeze({
          rolledBackBlocks: 0,
          orphanedEvents: 0,
          orphanedVersions: 0,
          restoredJobs: 0,
          orphanedJobs: 0,
          checkpoint: Object.freeze({ blockNumber: parentNumber, blockHash: parentHash }),
        });
      }

      const [parent] = await transaction
        .select({ blockHash: canonicalBlocks.blockHash })
        .from(canonicalBlocks)
        .where(
          and(
            eq(canonicalBlocks.networkId, targetNetwork),
            eq(canonicalBlocks.blockNumber, parentNumber.toString()),
            eq(canonicalBlocks.blockHash, parentHash),
          ),
        )
        .limit(1);
      if (!parent || parentNumber >= currentNumber) {
        throw new CheckpointError(
          "REORG_BEYOND_WINDOW",
          "reorg parent is not in the retained canonical window",
        );
      }

      const orphanedBlocks = await transaction
        .select({ blockHash: canonicalBlocks.blockHash })
        .from(canonicalBlocks)
        .where(
          and(
            eq(canonicalBlocks.networkId, targetNetwork),
            gt(canonicalBlocks.blockNumber, parentNumber.toString()),
          ),
        );
      const orphanedEventRows = await transaction
        .select({ jobId: jobEvents.jobId, txHash: jobEvents.txHash })
        .from(jobEvents)
        .where(
          and(
            eq(jobEvents.networkId, targetNetwork),
            eq(jobEvents.source, "indexed"),
            eq(jobEvents.canonical, true),
            gt(jobEvents.blockNumber, parentNumber.toString()),
          ),
        );
      const orphanedVersionRows = await transaction
        .select({ jobId: jobVersions.jobId })
        .from(jobVersions)
        .where(
          and(
            eq(jobVersions.networkId, targetNetwork),
            gt(jobVersions.observedBlockNumber, parentNumber.toString()),
            ne(jobVersions.status, "orphaned"),
          ),
        );
      const affectedJobIds = [
        ...new Set([
          ...orphanedEventRows.map(({ jobId }) => jobId),
          ...orphanedVersionRows.map(({ jobId }) => jobId),
        ]),
      ];
      const orphanedTxHashes = [
        ...new Set(
          orphanedEventRows
            .map(({ txHash }) => txHash)
            .filter((txHash): txHash is string => txHash !== null),
        ),
      ];
      const orphanedAt = new Date();

      if (orphanedEventRows.length > 0) {
        await transaction
          .update(jobEvents)
          .set({ canonical: false, orphanedAt })
          .where(
            and(
              eq(jobEvents.networkId, targetNetwork),
              eq(jobEvents.source, "indexed"),
              eq(jobEvents.canonical, true),
              gt(jobEvents.blockNumber, parentNumber.toString()),
            ),
          );
      }
      if (orphanedVersionRows.length > 0) {
        await transaction
          .update(jobVersions)
          .set({ status: "orphaned" })
          .where(
            and(
              eq(jobVersions.networkId, targetNetwork),
              gt(jobVersions.observedBlockNumber, parentNumber.toString()),
              ne(jobVersions.status, "orphaned"),
            ),
          );
      }
      if (orphanedTxHashes.length > 0) {
        await transaction
          .update(jobVersions)
          .set({ status: "live", spentTxHash: null })
          .where(
            and(
              eq(jobVersions.networkId, targetNetwork),
              eq(jobVersions.status, "spent"),
              lte(jobVersions.observedBlockNumber, parentNumber.toString()),
              inArray(jobVersions.spentTxHash, orphanedTxHashes),
            ),
          );
      }

      let restoredJobs = 0;
      let orphanedJobs = 0;
      for (const jobId of affectedJobIds) {
        const [latest] = await transaction
          .select({
            status: jobVersions.status,
            sequence: jobVersions.sequence,
            outpointTxHash: jobVersions.outpointTxHash,
            outpointIndex: jobVersions.outpointIndex,
            capacity: jobVersions.capacity,
            data: jobVersions.data,
            blockNumber: jobVersions.observedBlockNumber,
            blockHash: jobVersions.observedBlockHash,
            transactionIndex: jobVersions.transactionIndex,
          })
          .from(jobVersions)
          .where(
            and(
              eq(jobVersions.networkId, targetNetwork),
              eq(jobVersions.jobId, jobId),
              ne(jobVersions.status, "orphaned"),
            ),
          )
          .orderBy(desc(jobVersions.observedBlockNumber), desc(jobVersions.id))
          .limit(1);
        if (!latest) {
          await transaction
            .update(jobs)
            .set({ state: "orphaned", updatedAt: orphanedAt })
            .where(and(eq(jobs.networkId, targetNetwork), eq(jobs.jobId, jobId)));
          orphanedJobs += 1;
          continue;
        }
        if (latest.status !== "live" && latest.status !== "spent") {
          throw new Error("latest canonical job version has an invalid state");
        }
        await transaction
          .update(jobs)
          .set({
            outpointTxHash: latest.outpointTxHash,
            outpointIndex: latest.outpointIndex,
            sequence: latest.sequence,
            state: latest.status,
            capacity: latest.capacity,
            data: latest.data,
            blockNumber: latest.blockNumber,
            blockHash: latest.blockHash,
            transactionIndex: latest.transactionIndex,
            updatedAt: orphanedAt,
          })
          .where(and(eq(jobs.networkId, targetNetwork), eq(jobs.jobId, jobId)));
        restoredJobs += 1;
      }

      await transaction
        .delete(canonicalBlocks)
        .where(
          and(
            eq(canonicalBlocks.networkId, targetNetwork),
            gt(canonicalBlocks.blockNumber, parentNumber.toString()),
          ),
        );
      await transaction
        .update(indexerCheckpoints)
        .set({
          blockNumber: parentNumber.toString(),
          blockHash: parentHash,
          updatedAt: orphanedAt,
        })
        .where(eq(indexerCheckpoints.networkId, targetNetwork));

      return Object.freeze({
        rolledBackBlocks: orphanedBlocks.length,
        orphanedEvents: orphanedEventRows.length,
        orphanedVersions: orphanedVersionRows.length,
        restoredJobs,
        orphanedJobs,
        checkpoint: Object.freeze({ blockNumber: parentNumber, blockHash: parentHash }),
      });
    });
  }
}

export class CanonicalBlockProjector {
  readonly #ckbClient: Pick<CkbReadClient, "getBlockByNumber">;
  readonly #checkpoints: CanonicalCheckpointStore;
  readonly #rollback: JobProjectionRollback;
  readonly #discovery: JobCellDiscovery;
  readonly #transitions: JobTransitionIndexer;

  constructor(
    ckbClient: Pick<CkbReadClient, "getBlockByNumber">,
    checkpoints: CanonicalCheckpointStore,
    rollback: JobProjectionRollback,
    discovery: JobCellDiscovery,
    transitions: JobTransitionIndexer,
  ) {
    this.#ckbClient = ckbClient;
    this.#checkpoints = checkpoints;
    this.#rollback = rollback;
    this.#discovery = discovery;
    this.#transitions = transitions;
  }

  async scanBlock(
    blockNumberValue: bigint,
    deployment: RegisteredDeployment,
  ): Promise<CanonicalBlockProjectionResult> {
    const blockNumber = parseBlockNumber(blockNumberValue);
    const block = await this.#ckbClient.getBlockByNumber(blockNumber);
    if (!block) throw new Error("canonical block is unavailable");
    if (BigInt(block.header.number) !== blockNumber) {
      throw new Error("CKB client returned a block at the wrong height");
    }
    return this.projectBlock(block, deployment);
  }

  async projectBlock(
    block: ClientBlock,
    deployment: RegisteredDeployment,
  ): Promise<CanonicalBlockProjectionResult> {
    const blockNumber = parseBlockNumber(block.header.number.toString());
    const blockHash = parseHash32(block.header.hash);
    const parentHash = parseHash32(block.header.parentHash);
    const current = await this.#checkpoints.load(deployment.network);
    const replayingCurrent =
      current?.blockNumber === blockNumber && current.blockHash === blockHash;
    const extendsCurrent =
      current !== undefined &&
      blockNumber === current.blockNumber + 1n &&
      parentHash === current.blockHash;
    let rollback: ReorgRollbackResult | undefined;
    if (current && !replayingCurrent && !extendsCurrent) {
      if (blockNumber === 0n) {
        throw new CheckpointError("REORG_BEYOND_WINDOW", "genesis cannot replace indexed history");
      }
      rollback = await this.#rollback.rollbackToParent(
        deployment.network,
        blockNumber - 1n,
        parentHash,
      );
    }

    const discovery = await this.#discovery.projectBlock(block, deployment);
    const transitions = await this.#transitions.indexBlock(block, deployment);
    const checkpoint = await this.#checkpoints.record({
      networkId: deployment.network,
      blockNumber,
      blockHash,
      parentHash,
      blockTimestamp: BigInt(block.header.timestamp),
    });
    return Object.freeze({
      ...(rollback ? { rollback } : {}),
      discovery,
      transitions,
      checkpoint,
    });
  }
}
