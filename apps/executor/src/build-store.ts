import postgres from "postgres";

import { parseHash32, parseSequence, type Hash32 } from "@ckb-automata/core";

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
  readonly build_claim_expires_at: Date | null;
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
      max: 4,
      onnotice: () => undefined,
    });
  }

  async claim(payload: BuildQueuePayload): Promise<BuildClaimResult> {
    const jobId = parseHash32(payload.jobId);
    const sequence = parseSequence(payload.sequence).toString();
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
        SELECT id, intent_hash, build_claim_expires_at
        FROM transaction_attempts
        WHERE network_id = ${this.#network}
          AND job_id = ${jobId}
          AND sequence = ${sequence}
          AND operation = 'execute'
          AND state IN ('draft', 'submitted', 'proposed', 'committed', 'confirmed')
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
                updated_at = ${now}
            WHERE id = ${active.id} AND state = 'draft' AND intent_hash IS NULL
            RETURNING id, intent_hash, build_claim_expires_at
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
        });
      }

      const attemptId = createBuildAttemptId();
      await sql`
        INSERT INTO transaction_attempts (
          id, network_id, job_id, sequence, operation, state,
          build_claim_token, build_claim_expires_at
        ) VALUES (
          ${attemptId}, ${this.#network}, ${jobId}, ${sequence}, 'execute', 'draft',
          ${claimToken}, ${expiresAt}
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
