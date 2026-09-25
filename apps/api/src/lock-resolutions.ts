import { and, eq } from "drizzle-orm";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, type ScriptIdentity } from "@ckb-automata/core";

import type { AutomataDatabase } from "./database/client.ts";
import { lockResolutions } from "./database/schema.ts";

function sameScript(left: ScriptIdentity, right: ScriptIdentity): boolean {
  return (
    left.codeHash === right.codeHash && left.hashType === right.hashType && left.args === right.args
  );
}

export interface LockResolutionRecorder {
  remember(locks: readonly ScriptIdentity[]): Promise<void>;
}

export class LockResolutionStoreError extends Error {
  readonly code = "LOCK_RESOLUTION_STORE_UNAVAILABLE";

  constructor(cause: unknown) {
    super("verified lock resolutions could not be stored", { cause });
    this.name = "LockResolutionStoreError";
  }
}

export class PostgresLockResolutionRecorder implements LockResolutionRecorder {
  readonly #database: AutomataDatabase;
  readonly #network: string;

  constructor(database: AutomataDatabase, network: string) {
    this.#database = database;
    this.#network = network;
  }

  async remember(locks: readonly ScriptIdentity[]): Promise<void> {
    try {
      const unique = new Map<string, ScriptIdentity>();
      for (const lock of locks) {
        const lockHash = parseHash32(scriptToHash(lock));
        const existing = unique.get(lockHash);
        if (existing && !sameScript(existing, lock)) {
          throw new Error("lock resolution hash maps to conflicting scripts");
        }
        unique.set(lockHash, lock);
      }
      await this.#database.transaction(async (transaction) => {
        for (const [lockHash, lock] of unique) {
          await transaction
            .insert(lockResolutions)
            .values({
              networkId: this.#network,
              lockHash,
              codeHash: lock.codeHash,
              hashType: lock.hashType,
              args: lock.args,
            })
            .onConflictDoNothing();
          const [stored] = await transaction
            .select({
              codeHash: lockResolutions.codeHash,
              hashType: lockResolutions.hashType,
              args: lockResolutions.args,
            })
            .from(lockResolutions)
            .where(
              and(
                eq(lockResolutions.networkId, this.#network),
                eq(lockResolutions.lockHash, lockHash),
              ),
            )
            .limit(1);
          if (
            !stored ||
            stored.codeHash !== lock.codeHash ||
            stored.hashType !== lock.hashType ||
            stored.args !== lock.args
          ) {
            throw new Error("stored lock resolution does not match its verified script hash");
          }
        }
      });
    } catch (error) {
      if (error instanceof LockResolutionStoreError) throw error;
      throw new LockResolutionStoreError(error);
    }
  }
}
