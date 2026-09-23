import postgres from "postgres";

import { parseBlockNumber, parseHash32, type Hash32 } from "@ckb-automata/core";

import type {
  ConfirmationAttempt,
  ConfirmationEvidence,
  ConfirmationInclusion,
  ConfirmationQueuePayload,
  ConfirmationStore,
  ConfirmationTransition,
  RpcTransactionObservation,
} from "./confirmation.ts";

export const MAX_CONFIRMATION_ATTEMPTS = 500;

interface AttemptRow {
  readonly id: string;
  readonly tx_hash: string;
  readonly state: ConfirmationAttempt["state"];
  readonly submitted_at: Date;
  readonly committed_block_number: string | null;
}

interface EvidenceRow {
  readonly block_number: string;
  readonly block_hash: string;
  readonly tx_hash: string;
}

function inclusion(
  row: EvidenceRow,
  source: ConfirmationInclusion["source"],
): ConfirmationInclusion {
  return Object.freeze({
    blockNumber: parseBlockNumber(row.block_number).toString(),
    blockHash: parseHash32(row.block_hash),
    source,
  });
}

export class PostgresConfirmationStore implements ConfirmationStore {
  readonly #network: string;
  readonly #sql: postgres.Sql;
  readonly #now: () => Date;
  #closed = false;

  constructor(connectionString: string, network: string, now: () => Date = () => new Date()) {
    const url = new URL(connectionString);
    if (url.protocol !== "postgresql:") {
      throw new TypeError("confirmation database must use postgresql://");
    }
    this.#network = network;
    this.#now = now;
    this.#sql = postgres(connectionString, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: 3,
      onnotice: () => undefined,
    });
  }

  async listPending(
    options: { readonly afterAttemptId?: string; readonly limit?: number } = {},
  ): Promise<readonly ConfirmationQueuePayload[]> {
    const limit = options.limit ?? MAX_CONFIRMATION_ATTEMPTS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONFIRMATION_ATTEMPTS) {
      throw new RangeError(
        `confirmation scan limit must be between 1 and ${MAX_CONFIRMATION_ATTEMPTS}`,
      );
    }
    const after = options.afterAttemptId;
    const rows = await this.#sql<{ readonly id: string; readonly tx_hash: string }[]>`
      SELECT id, tx_hash
      FROM transaction_attempts
      WHERE network_id = ${this.#network}
        AND state IN ('submitted', 'proposed', 'committed')
        AND tx_hash IS NOT NULL
        ${after === undefined ? this.#sql`` : this.#sql`AND id > ${after}`}
      ORDER BY id
      LIMIT ${limit}
    `;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({ attemptId: row.id, transactionHash: parseHash32(row.tx_hash) }),
      ),
    );
  }

  async load(attemptId: string, transactionHash: Hash32): Promise<ConfirmationAttempt | undefined> {
    const rows = await this.#sql<AttemptRow[]>`
      SELECT id, tx_hash, state, submitted_at, committed_block_number::text
      FROM transaction_attempts
      WHERE network_id = ${this.#network}
        AND id = ${attemptId}
        AND tx_hash = ${transactionHash}
        AND state IN ('submitted', 'proposed', 'committed')
        AND submitted_at IS NOT NULL
      LIMIT 1
    `;
    const row = rows[0];
    return row
      ? Object.freeze({
          attemptId: row.id,
          transactionHash: parseHash32(row.tx_hash),
          state: row.state,
          submittedAt: row.submitted_at,
          ...(row.committed_block_number === null
            ? {}
            : {
                committedBlockNumber: parseBlockNumber(row.committed_block_number).toString(),
              }),
        })
      : undefined;
  }

  async evidence(
    attempt: ConfirmationAttempt,
    rpc: RpcTransactionObservation | undefined,
  ): Promise<ConfirmationEvidence> {
    const [network] = await this.#sql<
      { readonly confirmation_depth: number; readonly checkpoint: string | null }[]
    >`
      SELECT network.confirmation_depth,
             checkpoint.block_number::text AS checkpoint
      FROM networks AS network
      LEFT JOIN indexer_checkpoints AS checkpoint ON checkpoint.network_id = network.id
      WHERE network.id = ${this.#network}
      LIMIT 1
    `;
    if (!network) throw new Error("confirmation network is unavailable");
    const exact = await this.#sql<EvidenceRow[]>`
      SELECT event.block_number::text, event.block_hash, event.tx_hash
      FROM job_events AS event
      JOIN transaction_attempts AS attempt
        ON attempt.network_id = event.network_id AND attempt.job_id = event.job_id
      JOIN indexer_checkpoints AS checkpoint ON checkpoint.network_id = event.network_id
      WHERE attempt.id = ${attempt.attemptId}
        AND event.source = 'indexed'
        AND event.canonical = true
        AND event.tx_hash = ${attempt.transactionHash}
        AND event.block_number <= checkpoint.block_number
      ORDER BY event.block_number DESC, event.id DESC
      LIMIT 1
    `;
    let exactInclusion = exact[0] ? inclusion(exact[0], "indexed_event") : undefined;
    if (
      exactInclusion === undefined &&
      rpc?.status === "committed" &&
      rpc.blockNumber !== undefined &&
      rpc.blockHash !== undefined
    ) {
      const canonical = await this.#sql<EvidenceRow[]>`
        SELECT block.block_number::text, block.block_hash, ${attempt.transactionHash}::text AS tx_hash
        FROM canonical_blocks AS block
        JOIN indexer_checkpoints AS checkpoint ON checkpoint.network_id = block.network_id
        WHERE block.network_id = ${this.#network}
          AND block.block_number = ${rpc.blockNumber}
          AND block.block_hash = ${rpc.blockHash}
          AND block.block_number <= checkpoint.block_number
        LIMIT 1
      `;
      if (canonical[0]) exactInclusion = inclusion(canonical[0], "rpc_canonical_block");
    }
    const conflicts = await this.#sql<EvidenceRow[]>`
      SELECT event.block_number::text, event.block_hash, event.tx_hash
      FROM job_events AS event
      JOIN transaction_attempts AS attempt
        ON attempt.network_id = event.network_id AND attempt.job_id = event.job_id
      JOIN indexer_checkpoints AS checkpoint ON checkpoint.network_id = event.network_id
      WHERE attempt.id = ${attempt.attemptId}
        AND event.source = 'indexed'
        AND event.canonical = true
        AND event.tx_hash IS NOT NULL
        AND event.tx_hash <> ${attempt.transactionHash}
        AND event.block_number <= checkpoint.block_number
        AND event.payload->'previousOutpoint'->>'txHash' =
            attempt.chain_snapshot->'job'->'outPoint'->>'txHash'
        AND event.payload->'previousOutpoint'->>'index' =
            attempt.chain_snapshot->'job'->'outPoint'->>'index'
      ORDER BY event.block_number DESC, event.id DESC
      LIMIT 1
    `;
    const conflict = conflicts[0];
    return Object.freeze({
      requiredDepth: network.confirmation_depth,
      ...(network.checkpoint === null ? {} : { checkpointBlockNumber: network.checkpoint }),
      ...(exactInclusion === undefined ? {} : { inclusion: exactInclusion }),
      ...(conflict === undefined
        ? {}
        : {
            conflict: Object.freeze({
              ...inclusion(conflict, "indexed_event"),
              transactionHash: parseHash32(conflict.tx_hash),
            }),
          }),
    });
  }

  async apply(attempt: ConfirmationAttempt, transition: ConfirmationTransition): Promise<boolean> {
    const now = this.#now();
    return this.#sql.begin(async (sql) => {
      const rows = await sql<{ readonly network_id: string; readonly job_id: string }[]>`
        UPDATE transaction_attempts
        SET state = ${transition.state},
            committed_block_number = ${transition.state === "committed" || transition.state === "confirmed" ? (transition.block?.blockNumber ?? null) : null},
            confirmed_at = ${transition.state === "confirmed" ? now : null},
            error_code = ${transition.errorCode ?? null},
            error_detail = NULL,
            updated_at = ${now}
        WHERE network_id = ${this.#network}
          AND id = ${attempt.attemptId}
          AND tx_hash = ${attempt.transactionHash}
          AND state = ${attempt.state}
          AND job_id IS NOT NULL
        RETURNING network_id, job_id
      `;
      const updated = rows[0];
      if (!updated) return false;
      await sql`
        INSERT INTO job_events (
          network_id, job_id, event_type, source, block_number, block_hash,
          tx_hash, payload, occurred_at
        ) VALUES (
          ${updated.network_id}, ${updated.job_id}, ${transition.eventType},
          ${transition.block === undefined ? "operational" : "indexed"},
          ${transition.block?.blockNumber ?? null}, ${transition.block?.blockHash ?? null},
          ${transition.relatedTransactionHash ?? attempt.transactionHash},
          ${sql.json({
            attemptId: attempt.attemptId,
            observedStatus: transition.observedStatus,
            ...(transition.errorCode === undefined ? {} : { errorCode: transition.errorCode }),
            ...(transition.relatedTransactionHash === undefined
              ? {}
              : { relatedTransactionHash: transition.relatedTransactionHash }),
            ...(transition.confirmations === undefined
              ? {}
              : {
                  confirmations: transition.confirmations,
                  requiredDepth: transition.requiredDepth,
                  evidenceSource: transition.block?.source,
                }),
          })},
          ${now}
        )
      `;
      return true;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sql.end({ timeout: 5 });
  }
}
