import postgres from "postgres";

import { parseHash32, type Hash32 } from "@ckb-automata/core";

import type { SimulationAttempt, SimulationRecord, SimulationStore } from "./simulation.ts";

interface SimulationRow {
  readonly id: string;
  readonly intent_hash: string;
  readonly unsigned_transaction: postgres.JSONValue;
  readonly chain_snapshot: postgres.JSONValue;
}

function jsonRecord(value: postgres.JSONValue, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not a JSON object`);
  }
  return Object.freeze(value as Record<string, unknown>);
}

export class PostgresSimulationStore implements SimulationStore {
  readonly #sql: postgres.Sql;
  #closed = false;

  constructor(connectionString: string) {
    const url = new URL(connectionString);
    if (url.protocol !== "postgresql:") {
      throw new TypeError("simulation database must use postgresql://");
    }
    this.#sql = postgres(connectionString, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: 2,
      onnotice: () => undefined,
    });
  }

  async load(attemptId: string, intentHash: Hash32): Promise<SimulationAttempt | undefined> {
    const rows = await this.#sql<SimulationRow[]>`
      SELECT id, intent_hash, unsigned_transaction, chain_snapshot
      FROM transaction_attempts
      WHERE id = ${attemptId}
        AND intent_hash = ${intentHash}
        AND operation = 'execute'
        AND state = 'draft'
        AND unsigned_transaction IS NOT NULL
        AND chain_snapshot IS NOT NULL
      LIMIT 1
    `;
    const row = rows[0];
    return row
      ? Object.freeze({
          attemptId: row.id,
          intentHash: parseHash32(row.intent_hash),
          transaction: jsonRecord(row.unsigned_transaction, "unsigned transaction"),
          snapshot: jsonRecord(row.chain_snapshot, "chain snapshot"),
        })
      : undefined;
  }

  async approve(attempt: SimulationAttempt, record: SimulationRecord): Promise<boolean> {
    const rows = await this.#sql<{ readonly id: string }[]>`
      UPDATE transaction_attempts
      SET state = 'awaiting_signature',
          simulation = ${this.#sql.json(record as unknown as postgres.JSONValue)},
          error_code = NULL,
          error_detail = NULL,
          updated_at = now()
      WHERE id = ${attempt.attemptId}
        AND intent_hash = ${attempt.intentHash}
        AND state = 'draft'
      RETURNING id
    `;
    return rows.length === 1;
  }

  async reject(attempt: SimulationAttempt, errorCode: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{2,95}$/.test(errorCode)) {
      throw new TypeError("simulation failure code is invalid");
    }
    await this.#sql`
      UPDATE transaction_attempts
      SET state = 'recovery_required',
          simulation = ${this.#sql.json({ status: "rejected", errorCode })},
          error_code = ${errorCode},
          error_detail = NULL,
          updated_at = now()
      WHERE id = ${attempt.attemptId}
        AND intent_hash = ${attempt.intentHash}
        AND state = 'draft'
    `;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sql.end({ timeout: 5 });
  }
}
