import { isDeepStrictEqual } from "node:util";

import postgres from "postgres";

import {
  parseDeadLetterPayload,
  type DeadLetterAction,
  type DeadLetterActionKind,
  type DeadLetterCloseDecision,
  type DeadLetterRecord,
  type DeadLetterReplayDecision,
  type DeadLetterSourceQueue,
  type DeadLetterStore,
} from "./dead-letter.ts";
import { stableQueueJobId, type DeadLetterPayload } from "./queues.ts";

interface RecordRow {
  readonly id: string;
  readonly queue: string;
  readonly job_key: string;
  readonly reason: string;
  readonly payload: postgres.JSONValue;
  readonly attempts: number;
  readonly failed_at: Date;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
}

interface ActionRow {
  readonly id: string;
  readonly action: DeadLetterActionKind;
  readonly operator: string;
  readonly reason: string | null;
  readonly replay_job_id: string | null;
  readonly dispatched_at: Date | null;
  readonly created_at: Date;
}

function sourceQueue(value: string): DeadLetterSourceQueue {
  if (!["discovery", "evaluate", "build", "submit", "confirm", "notify"].includes(value)) {
    throw new Error("stored dead-letter queue is invalid");
  }
  return value as DeadLetterSourceQueue;
}

function action(row: ActionRow): DeadLetterAction {
  return Object.freeze({
    id: row.id,
    action: row.action,
    operator: row.operator,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.replay_job_id === null ? {} : { replayJobId: row.replay_job_id }),
    ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
    createdAt: row.created_at,
  });
}

function record(row: RecordRow, actions: readonly ActionRow[] = []): DeadLetterRecord {
  return Object.freeze({
    id: row.id,
    queue: sourceQueue(row.queue),
    jobKey: row.job_key,
    reason: row.reason,
    payload: parseDeadLetterPayload(row.payload),
    attempts: row.attempts,
    failedAt: row.failed_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    createdAt: row.created_at,
    actions: Object.freeze(actions.map(action)),
  });
}

async function selectRecord(sql: postgres.Sql | postgres.TransactionSql, id: string, lock = false) {
  const rows = await sql.unsafe<RecordRow[]>(
    `SELECT id::text, queue, job_key, reason, payload, attempts, failed_at, resolved_at, created_at
     FROM dead_letters WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`dead-letter ${id} was not found`);
  return row;
}

async function selectActions(sql: postgres.Sql | postgres.TransactionSql, id: string) {
  return sql.unsafe<ActionRow[]>(
    `SELECT id::text, action, operator, reason, replay_job_id, dispatched_at, created_at
     FROM dead_letter_actions WHERE dead_letter_id = $1 ORDER BY id`,
    [id],
  );
}

export class PostgresDeadLetterStore implements DeadLetterStore {
  readonly #sql: postgres.Sql;
  readonly #now: () => Date;
  #closed = false;

  constructor(connectionString: string, now: () => Date = () => new Date()) {
    const url = new URL(connectionString);
    if (url.protocol !== "postgresql:")
      throw new TypeError("dead-letter database must use postgresql://");
    this.#now = now;
    this.#sql = postgres(connectionString, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: 1,
      onnotice: () => undefined,
    });
  }

  async persist(payload: DeadLetterPayload): Promise<DeadLetterRecord> {
    const value = parseDeadLetterPayload(payload);
    const rows = await this.#sql<RecordRow[]>`
      INSERT INTO dead_letters (queue, job_key, reason, payload, attempts, failed_at)
      VALUES (
        ${value.sourceQueue}, ${value.sourceJobId}, ${value.failureCode},
        ${this.#sql.json(value as unknown as postgres.JSONValue)}, ${value.attempts},
        ${new Date(value.failedAt)}
      )
      ON CONFLICT (queue, job_key) DO UPDATE SET job_key = EXCLUDED.job_key
      RETURNING id::text, queue, job_key, reason, payload, attempts, failed_at,
                resolved_at, created_at
    `;
    const row = rows[0];
    if (!row) throw new Error("dead-letter persistence returned no record");
    const storedPayload = parseDeadLetterPayload(row.payload);
    if (
      row.reason !== value.failureCode ||
      row.attempts !== value.attempts ||
      row.failed_at.toISOString() !== value.failedAt ||
      !isDeepStrictEqual(storedPayload, value)
    ) {
      throw new Error("duplicate dead-letter evidence does not match the persisted record");
    }
    return record(row);
  }

  async inspect(id: string, operator: string): Promise<DeadLetterRecord> {
    return this.#sql.begin(async (sql) => {
      const row = await selectRecord(sql, id);
      await sql`
        INSERT INTO dead_letter_actions (dead_letter_id, action, operator)
        VALUES (${id}, 'inspect', ${operator})
      `;
      return record(row, await selectActions(sql, id));
    });
  }

  async beginReplay(
    id: string,
    operator: string,
    reason: string,
  ): Promise<DeadLetterReplayDecision> {
    return this.#sql.begin(async (sql) => {
      const row = await selectRecord(sql, id, true);
      const replayJobId = stableQueueJobId(sourceQueue(row.queue), `dead-letter/${id}/replay`);
      await sql`
        INSERT INTO dead_letter_actions (dead_letter_id, action, operator)
        VALUES (${id}, 'inspect', ${operator})
      `;
      const existing = (await selectActions(sql, id)).find(({ action: kind }) => kind === "replay");
      if (existing) {
        if (existing.replay_job_id !== replayJobId) {
          throw new Error("dead-letter replay identity changed");
        }
        return Object.freeze({
          record: record(row, await selectActions(sql, id)),
          replayJobId,
          idempotent: true,
          ...(existing.dispatched_at === null ? {} : { dispatchedAt: existing.dispatched_at }),
        });
      }
      if (row.resolved_at !== null) throw new Error("closed dead-letter work cannot be replayed");
      const now = this.#now();
      await sql`
        INSERT INTO dead_letter_actions (
          dead_letter_id, action, operator, reason, replay_job_id, created_at
        ) VALUES (${id}, 'replay', ${operator}, ${reason}, ${replayJobId}, ${now})
      `;
      await sql`UPDATE dead_letters SET resolved_at = ${now} WHERE id = ${id}`;
      const resolved = { ...row, resolved_at: now };
      return Object.freeze({
        record: record(resolved, await selectActions(sql, id)),
        replayJobId,
        idempotent: false,
      });
    });
  }

  async markReplayDispatched(id: string, replayJobId: string): Promise<Date> {
    return this.#sql.begin(async (sql) => {
      await selectRecord(sql, id, true);
      const [existing] = await sql<ActionRow[]>`
        SELECT id::text, action, operator, reason, replay_job_id, dispatched_at, created_at
        FROM dead_letter_actions
        WHERE dead_letter_id = ${id} AND action = 'replay'
        FOR UPDATE
      `;
      if (!existing || existing.replay_job_id !== replayJobId) {
        throw new Error("dead-letter replay decision is unavailable");
      }
      if (existing.dispatched_at !== null) return existing.dispatched_at;
      const now = this.#now();
      await sql`
        UPDATE dead_letter_actions SET dispatched_at = ${now}
        WHERE id = ${existing.id}
      `;
      return now;
    });
  }

  async close(id: string, operator: string, reason: string): Promise<DeadLetterCloseDecision> {
    return this.#sql.begin(async (sql) => {
      const row = await selectRecord(sql, id, true);
      const actions = await selectActions(sql, id);
      const existing = actions.find(({ action: kind }) => kind === "close");
      if (existing) {
        return Object.freeze({ record: record(row, actions), idempotent: true });
      }
      if (actions.some(({ action: kind }) => kind === "replay")) {
        throw new Error("replayed dead-letter work cannot be closed");
      }
      if (row.resolved_at !== null) throw new Error("dead-letter work is already resolved");
      const now = this.#now();
      await sql`
        INSERT INTO dead_letter_actions (dead_letter_id, action, operator, reason, created_at)
        VALUES (${id}, 'close', ${operator}, ${reason}, ${now})
      `;
      await sql`UPDATE dead_letters SET resolved_at = ${now} WHERE id = ${id}`;
      return Object.freeze({
        record: record({ ...row, resolved_at: now }, await selectActions(sql, id)),
        idempotent: false,
      });
    });
  }

  async closeConnection(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sql.end({ timeout: 5 });
  }
}
