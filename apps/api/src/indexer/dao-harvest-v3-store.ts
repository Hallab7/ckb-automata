import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AutomataDatabase } from "../database/client.ts";
import { daoHarvestV3Events, daoHarvestV3Jobs } from "../database/schema.ts";
import {
  rebuildDaoHarvestV3Snapshot,
  type DaoHarvestV3ProjectionEvent,
} from "./dao-harvest-v3-projection.ts";

function eventFromRow(row: typeof daoHarvestV3Events.$inferSelect): DaoHarvestV3ProjectionEvent {
  if (
    typeof row.projection !== "object" ||
    row.projection === null ||
    Array.isArray(row.projection)
  )
    throw new Error("stored V3 projection event is invalid");
  const event = row.projection as unknown as DaoHarvestV3ProjectionEvent;
  if (
    event.eventId !== row.eventId ||
    event.jobId !== row.jobId ||
    event.transactionHash !== row.transactionHash ||
    event.blockHash !== row.blockHash ||
    event.operation !== row.operation
  )
    throw new Error("stored V3 projection provenance contradicts its event row");
  return Object.freeze({ ...event, canonical: row.canonical });
}

export class DaoHarvestV3ProjectionStore {
  readonly #database: AutomataDatabase;
  constructor(database: AutomataDatabase) {
    this.#database = database;
  }

  async trackedOutPoints(networkId: string): Promise<ReadonlySet<string>> {
    const rows = await this.#database
      .select({ projection: daoHarvestV3Jobs.projection })
      .from(daoHarvestV3Jobs)
      .where(and(eq(daoHarvestV3Jobs.networkId, networkId), eq(daoHarvestV3Jobs.canonical, true)));
    const keys = rows.flatMap(({ projection }) => {
      if (typeof projection !== "object" || projection === null || Array.isArray(projection)) {
        return [];
      }
      const item = projection as Record<string, unknown>;
      return [item["jobOutPoint"], item["vaultOutPoint"], item["compensationOutPoint"]].flatMap(
        (value) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
          const outPoint = value as Record<string, unknown>;
          return typeof outPoint["txHash"] === "string" && typeof outPoint["index"] === "string"
            ? [`${outPoint["txHash"]}:${BigInt(outPoint["index"]).toString()}`]
            : [];
        },
      );
    });
    return new Set(keys);
  }

  async append(events: readonly DaoHarvestV3ProjectionEvent[]) {
    if (events.length === 0) return Object.freeze([]);
    const network = events[0]!.networkId;
    if (events.some((event) => event.networkId !== network || !event.canonical))
      throw new Error("V3 projection append requires one network of canonical events");
    return this.#database.transaction(async (transaction) => {
      const existing = await transaction
        .select()
        .from(daoHarvestV3Events)
        .where(
          and(
            eq(daoHarvestV3Events.networkId, network),
            inArray(
              daoHarvestV3Events.eventId,
              events.map(({ eventId }) => eventId),
            ),
          ),
        );
      const byId = new Map(existing.map((row) => [row.eventId, eventFromRow(row)]));
      for (const event of events) {
        const prior = byId.get(event.eventId);
        if (prior && !isDeepStrictEqual({ ...prior, canonical: true }, event))
          throw new Error("duplicate V3 event contradicts stored chain evidence");
        await transaction
          .insert(daoHarvestV3Events)
          .values({
            networkId: event.networkId,
            eventId: event.eventId,
            jobId: event.jobId,
            operation: event.operation,
            transactionHash: event.transactionHash,
            transactionIndex: event.transactionIndex,
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            canonical: true,
            projection: event,
          })
          .onConflictDoUpdate({
            target: [daoHarvestV3Events.networkId, daoHarvestV3Events.eventId],
            set: { projection: event, canonical: true, orphanedAt: null },
          });
      }
      return this.#rebuild(transaction as AutomataDatabase, network, [
        ...new Set(events.map(({ jobId }) => jobId)),
      ]);
    });
  }

  async rollback(networkId: string, orphanedBlockHashes: readonly string[]) {
    if (orphanedBlockHashes.length === 0) return Object.freeze([]);
    return this.#database.transaction(async (transaction) => {
      const affected = await transaction
        .select({ jobId: daoHarvestV3Events.jobId })
        .from(daoHarvestV3Events)
        .where(
          and(
            eq(daoHarvestV3Events.networkId, networkId),
            inArray(daoHarvestV3Events.blockHash, [...orphanedBlockHashes]),
            eq(daoHarvestV3Events.canonical, true),
          ),
        );
      await transaction
        .update(daoHarvestV3Events)
        .set({ canonical: false, orphanedAt: new Date() })
        .where(
          and(
            eq(daoHarvestV3Events.networkId, networkId),
            inArray(daoHarvestV3Events.blockHash, [...orphanedBlockHashes]),
          ),
        );
      return this.#rebuild(transaction as AutomataDatabase, networkId, [
        ...new Set(affected.map(({ jobId }) => jobId)),
      ]);
    });
  }

  async reset(networkId: string) {
    return this.#database.transaction(async (transaction) => {
      await transaction.delete(daoHarvestV3Jobs).where(eq(daoHarvestV3Jobs.networkId, networkId));
      const rows = await transaction
        .select({ jobId: daoHarvestV3Events.jobId })
        .from(daoHarvestV3Events)
        .where(
          and(eq(daoHarvestV3Events.networkId, networkId), eq(daoHarvestV3Events.canonical, true)),
        );
      return this.#rebuild(transaction as AutomataDatabase, networkId, [
        ...new Set(rows.map(({ jobId }) => jobId)),
      ]);
    });
  }

  async #rebuild(database: AutomataDatabase, networkId: string, jobIds: readonly string[]) {
    const snapshots = [];
    for (const jobId of jobIds) {
      const rows = await database
        .select()
        .from(daoHarvestV3Events)
        .where(
          and(
            eq(daoHarvestV3Events.networkId, networkId),
            eq(daoHarvestV3Events.jobId, jobId),
            eq(daoHarvestV3Events.canonical, true),
          ),
        )
        .orderBy(
          asc(daoHarvestV3Events.blockNumber),
          asc(daoHarvestV3Events.transactionIndex),
          asc(daoHarvestV3Events.eventId),
        );
      const snapshot = rebuildDaoHarvestV3Snapshot(rows.map(eventFromRow));
      if (!snapshot) {
        await database
          .delete(daoHarvestV3Jobs)
          .where(and(eq(daoHarvestV3Jobs.networkId, networkId), eq(daoHarvestV3Jobs.jobId, jobId)));
        continue;
      }
      const values = {
        networkId,
        jobId: snapshot.jobId,
        ownerLockHash: snapshot.ownerLockHash,
        lifecycleState: snapshot.lifecycleState,
        projection: snapshot,
        observedBlockNumber: snapshot.blockNumber,
        observedBlockHash: snapshot.blockHash,
        observedTransactionHash: snapshot.transactionHash,
        canonical: true,
        updatedAt: new Date(),
      } as const;
      await database
        .insert(daoHarvestV3Jobs)
        .values(values)
        .onConflictDoUpdate({
          target: [daoHarvestV3Jobs.networkId, daoHarvestV3Jobs.jobId],
          set: values,
        });
      snapshots.push(snapshot);
    }
    return Object.freeze(snapshots);
  }
}
