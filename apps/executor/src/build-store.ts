import postgres from "postgres";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, parseSequence, type Hash32, type ScriptIdentity } from "@ckb-automata/core";

import {
  BUILD_CLAIM_LEASE_MS,
  createBuildAttemptId,
  type BuildAttemptClaim,
  type BuildAttemptStore,
  type BuildClaimResult,
} from "./build.ts";
import { eligibilityRecordFromRow, type EligibilityRow } from "./eligibility-worker.ts";
import type { BuildQueuePayload } from "./eligibility.ts";

interface AttemptRow {
  readonly id: string;
  readonly intent_hash: string | null;
  readonly builder_lock_hash: string | null;
  readonly build_claim_expires_at: Date | null;
}

interface LockResolutionRow {
  readonly lock_hash: string;
  readonly code_hash: string;
  readonly hash_type: string;
  readonly args: string;
}

function canonicalLock(value: ScriptIdentity): ScriptIdentity {
  if (value.hashType !== "data" && value.hashType !== "data1" && value.hashType !== "type") {
    throw new TypeError("stored lock resolution hash type is unsupported");
  }
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value.args)) {
    throw new TypeError("stored lock resolution args are invalid");
  }
  return Object.freeze({
    codeHash: parseHash32(value.codeHash),
    hashType: value.hashType,
    args: value.args,
  });
}

export class PostgresBuildAttemptStore implements BuildAttemptStore {
  readonly #network: string;
  readonly #sql: postgres.Sql;
  readonly #now: () => Date;
  #closed = false;

  constructor(connectionString: string, network: string, now: () => Date = () => new Date()) {
    const url = new URL(connectionString);
    if (url.protocol !== "postgresql:") {
      throw new TypeError("build database must use postgresql://");
    }
    this.#network = network;
    this.#now = now;
    this.#sql = postgres(connectionString, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: 1,
      onnotice: () => undefined,
    });
  }

  async claim(payload: BuildQueuePayload, builderLockHash: Hash32): Promise<BuildClaimResult> {
    const jobId = parseHash32(payload.jobId);
    const sequence = parseSequence(payload.sequence).toString();
    const canonicalBuilderLockHash = parseHash32(builderLockHash);
    const claimToken = createBuildAttemptId();
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + BUILD_CLAIM_LEASE_MS);
    return this.#sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.#network}/${jobId}/${sequence}`}, 0))`;
      const jobs = await sql<EligibilityRow[]>`
        SELECT network_id, job_id, sequence, policy_kind, data, capacity,
               outpoint_tx_hash, outpoint_index, block_hash, block_number
        FROM jobs
        WHERE network_id = ${this.#network}
          AND job_id = ${jobId}
          AND sequence = ${sequence}
          AND state = 'live'
        LIMIT 1
      `;
      const job = jobs[0];
      if (!job) return Object.freeze({ status: "stale" as const });

      const existing = await sql<AttemptRow[]>`
        SELECT id, intent_hash, builder_lock_hash, build_claim_expires_at
        FROM transaction_attempts
        WHERE network_id = ${this.#network}
          AND job_id = ${jobId}
          AND sequence = ${sequence}
          AND operation = 'execute'
          AND state IN (
            'draft', 'awaiting_signature', 'submitted', 'proposed', 'committed', 'confirmed'
          )
        LIMIT 1
        FOR UPDATE
      `;
      const active = existing[0];
      if (active) {
        if (
          active.intent_hash === null &&
          (active.build_claim_expires_at === null || active.build_claim_expires_at <= now)
        ) {
          const reclaimed = await sql<AttemptRow[]>`
            UPDATE transaction_attempts
            SET build_claim_token = ${claimToken},
                build_claim_expires_at = ${expiresAt},
                builder_lock_hash = ${canonicalBuilderLockHash},
                updated_at = ${now}
            WHERE id = ${active.id} AND state = 'draft' AND intent_hash IS NULL
            RETURNING id, intent_hash, builder_lock_hash, build_claim_expires_at
          `;
          if (reclaimed[0]) {
            return Object.freeze({
              status: "claimed" as const,
              claim: Object.freeze({
                attemptId: active.id,
                claimToken,
                record: eligibilityRecordFromRow(job),
              }),
            });
          }
        }
        return Object.freeze({
          status: "duplicate" as const,
          attemptId: active.id,
          ...(active.intent_hash === null ? {} : { intentHash: parseHash32(active.intent_hash) }),
          ...(active.builder_lock_hash === null
            ? {}
            : { builderLockHash: parseHash32(active.builder_lock_hash) }),
        });
      }

      const attemptId = createBuildAttemptId();
      await sql`
        INSERT INTO transaction_attempts (
          id, network_id, job_id, sequence, operation, state,
          build_claim_token, build_claim_expires_at, builder_lock_hash
        ) VALUES (
          ${attemptId}, ${this.#network}, ${jobId}, ${sequence}, 'execute', 'draft',
          ${claimToken}, ${expiresAt}, ${canonicalBuilderLockHash}
        )
      `;
      return Object.freeze({
        status: "claimed" as const,
        claim: Object.freeze({
          attemptId,
          claimToken,
          record: eligibilityRecordFromRow(job),
        }),
      });
    });
  }

  async loadResolvedLocks(): Promise<readonly ScriptIdentity[]> {
    const rows = await this.#sql<LockResolutionRow[]>`
      SELECT lock_hash, code_hash, hash_type, args
      FROM lock_resolutions
      WHERE network_id = ${this.#network}
      ORDER BY lock_hash
    `;
    return Object.freeze(
      rows.map((row) => {
        const lock = canonicalLock({
          codeHash: parseHash32(row.code_hash),
          hashType: row.hash_type as ScriptIdentity["hashType"],
          args: row.args as `0x${string}`,
        });
        if (parseHash32(scriptToHash(lock)) !== parseHash32(row.lock_hash)) {
          throw new Error("stored lock resolution does not match its script hash");
        }
        return lock;
      }),
    );
  }

  async rememberResolvedLocks(locks: readonly ScriptIdentity[]): Promise<void> {
    const resolved = new Map<string, ScriptIdentity>();
    for (const value of locks) {
      const lock = canonicalLock(value);
      resolved.set(parseHash32(scriptToHash(lock)), lock);
    }
    await this.#sql.begin(async (sql) => {
      for (const [lockHash, lock] of resolved) {
        await sql`
          INSERT INTO lock_resolutions (network_id, lock_hash, code_hash, hash_type, args)
          VALUES (${this.#network}, ${lockHash}, ${lock.codeHash}, ${lock.hashType}, ${lock.args})
          ON CONFLICT (network_id, lock_hash) DO NOTHING
        `;
        const [stored] = await sql<LockResolutionRow[]>`
          SELECT lock_hash, code_hash, hash_type, args
          FROM lock_resolutions
          WHERE network_id = ${this.#network} AND lock_hash = ${lockHash}
          LIMIT 1
        `;
        if (
          !stored ||
          stored.code_hash !== lock.codeHash ||
          stored.hash_type !== lock.hashType ||
          stored.args !== lock.args
        ) {
          throw new Error("stored lock resolution does not match its verified script hash");
        }
      }
    });
  }

  async complete(
    claim: BuildAttemptClaim,
    snapshot: Readonly<Record<string, unknown>>,
    intentHash: Hash32,
    transaction: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const rows = await this.#sql<{ readonly id: string }[]>`
      UPDATE transaction_attempts
      SET chain_snapshot = ${this.#sql.json(snapshot as postgres.JSONValue)},
          intent_hash = ${intentHash},
          unsigned_tx_hash = ${intentHash},
          unsigned_transaction = ${this.#sql.json(transaction as postgres.JSONValue)},
          build_claim_token = NULL,
          build_claim_expires_at = NULL,
          updated_at = ${this.#now()}
      WHERE id = ${claim.attemptId}
        AND state = 'draft'
        AND build_claim_token = ${claim.claimToken}
        AND build_claim_expires_at > ${this.#now()}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async fail(
    claim: BuildAttemptClaim,
    state: "conflicted" | "recovery_required",
    errorCode: string,
  ): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{2,95}$/.test(errorCode)) {
      throw new TypeError("build failure code is invalid");
    }
    await this.#sql`
      UPDATE transaction_attempts
      SET state = ${state},
          error_code = ${errorCode},
          build_claim_token = NULL,
          build_claim_expires_at = NULL,
          updated_at = ${this.#now()}
      WHERE id = ${claim.attemptId}
        AND state = 'draft'
        AND build_claim_token = ${claim.claimToken}
    `;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sql.end({ timeout: 5 });
  }
}
