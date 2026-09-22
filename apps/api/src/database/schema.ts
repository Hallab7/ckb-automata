import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const hash = (name: string) => varchar(name, { length: 66 });
const uint32 = (name: string) => numeric(name, { precision: 10, scale: 0 });
const uint64 = (name: string) => numeric(name, { precision: 20, scale: 0 });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const networks = pgTable(
  "networks",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    genesisHash: hash("genesis_hash").notNull(),
    rpcProfile: varchar("rpc_profile", { length: 64 }).notNull(),
    confirmationDepth: integer("confirmation_depth").notNull(),
    deploymentManifestHash: varchar("deployment_manifest_hash", { length: 64 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("networks_genesis_hash_uq").on(table.genesisHash),
    check("networks_genesis_hash_ck", sql`${table.genesisHash} ~ '^0x[0-9a-f]{64}$'`),
    check("networks_rpc_profile_ck", sql`${table.rpcProfile} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`),
    check("networks_confirmation_depth_ck", sql`${table.confirmationDepth} > 0`),
    check("networks_manifest_hash_ck", sql`${table.deploymentManifestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const scriptDeployments = pgTable(
  "script_deployments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    codeHash: hash("code_hash").notNull(),
    hashType: varchar("hash_type", { length: 8 }).notNull(),
    deploymentTxHash: hash("deployment_tx_hash").notNull(),
    outputIndex: uint32("output_index").notNull(),
    depType: varchar("dep_type", { length: 10 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("script_deployments_network_name_uq").on(table.networkId, table.name),
    check("script_deployments_code_hash_ck", sql`${table.codeHash} ~ '^0x[0-9a-f]{64}$'`),
    check("script_deployments_tx_hash_ck", sql`${table.deploymentTxHash} ~ '^0x[0-9a-f]{64}$'`),
    check("script_deployments_hash_type_ck", sql`${table.hashType} IN ('data', 'type', 'data1')`),
    check("script_deployments_dep_type_ck", sql`${table.depType} IN ('code', 'dep_group')`),
    check("script_deployments_output_index_ck", sql`${table.outputIndex} BETWEEN 0 AND 4294967295`),
  ],
);

export const indexerCheckpoints = pgTable(
  "indexer_checkpoints",
  {
    networkId: varchar("network_id", { length: 64 })
      .primaryKey()
      .references(() => networks.id, { onDelete: "cascade" }),
    blockNumber: uint64("block_number").notNull(),
    blockHash: hash("block_hash").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("indexer_checkpoints_block_number_ck", sql`${table.blockNumber} >= 0`),
    check("indexer_checkpoints_block_hash_ck", sql`${table.blockHash} ~ '^0x[0-9a-f]{64}$'`),
  ],
);

export const canonicalBlocks = pgTable(
  "canonical_blocks",
  {
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    blockNumber: uint64("block_number").notNull(),
    blockHash: hash("block_hash").notNull(),
    parentHash: hash("parent_hash").notNull(),
    blockTimestamp: uint64("block_timestamp").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.networkId, table.blockNumber] }),
    uniqueIndex("canonical_blocks_network_hash_uq").on(table.networkId, table.blockHash),
    index("canonical_blocks_network_height_idx").on(table.networkId, table.blockNumber),
    check("canonical_blocks_block_number_ck", sql`${table.blockNumber} >= 0`),
    check("canonical_blocks_hash_ck", sql`${table.blockHash} ~ '^0x[0-9a-f]{64}$'`),
    check("canonical_blocks_parent_hash_ck", sql`${table.parentHash} ~ '^0x[0-9a-f]{64}$'`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    jobId: hash("job_id").notNull(),
    outpointTxHash: hash("outpoint_tx_hash").notNull(),
    outpointIndex: uint32("outpoint_index").notNull(),
    sequence: uint64("sequence").notNull(),
    ownerLockHash: hash("owner_lock_hash").notNull(),
    policyScriptHash: hash("policy_script_hash").notNull(),
    policyKind: varchar("policy_kind", { length: 32 }).notNull(),
    state: varchar("state", { length: 24 }).notNull(),
    capacity: uint64("capacity").notNull(),
    data: bytea("data").notNull(),
    blockNumber: uint64("block_number").notNull(),
    blockHash: hash("block_hash").notNull(),
    transactionIndex: uint32("transaction_index").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.networkId, table.jobId] }),
    uniqueIndex("jobs_network_outpoint_uq").on(
      table.networkId,
      table.outpointTxHash,
      table.outpointIndex,
    ),
    index("jobs_network_state_idx").on(table.networkId, table.state, table.blockNumber),
    index("jobs_owner_lock_hash_idx").on(table.networkId, table.ownerLockHash),
    check("jobs_job_id_ck", sql`${table.jobId} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_outpoint_hash_ck", sql`${table.outpointTxHash} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_owner_hash_ck", sql`${table.ownerLockHash} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_policy_hash_ck", sql`${table.policyScriptHash} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_block_hash_ck", sql`${table.blockHash} ~ '^0x[0-9a-f]{64}$'`),
    check("jobs_state_ck", sql`${table.state} IN ('live', 'spent', 'orphaned')`),
    check(
      "jobs_unsigned_values_ck",
      sql`${table.outpointIndex} >= 0 AND ${table.sequence} >= 0 AND ${table.capacity} >= 0 AND ${table.blockNumber} >= 0 AND ${table.transactionIndex} >= 0`,
    ),
  ],
);

export const jobVersions = pgTable(
  "job_versions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    networkId: varchar("network_id", { length: 64 }).notNull(),
    jobId: hash("job_id").notNull(),
    sequence: uint64("sequence").notNull(),
    outpointTxHash: hash("outpoint_tx_hash").notNull(),
    outpointIndex: uint32("outpoint_index").notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    capacity: uint64("capacity").notNull(),
    data: bytea("data").notNull(),
    observedBlockNumber: uint64("observed_block_number").notNull(),
    observedBlockHash: hash("observed_block_hash").notNull(),
    transactionIndex: uint32("transaction_index").notNull().default("0"),
    spentTxHash: hash("spent_tx_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.networkId, table.jobId],
      foreignColumns: [jobs.networkId, jobs.jobId],
    }).onDelete("cascade"),
    uniqueIndex("job_versions_network_outpoint_uq").on(
      table.networkId,
      table.outpointTxHash,
      table.outpointIndex,
    ),
    index("job_versions_job_idx").on(table.networkId, table.jobId, table.sequence),
    check("job_versions_status_ck", sql`${table.status} IN ('live', 'spent', 'orphaned')`),
    check(
      "job_versions_transaction_index_ck",
      sql`${table.transactionIndex} BETWEEN 0 AND 4294967295`,
    ),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    networkId: varchar("network_id", { length: 64 }).notNull(),
    jobId: hash("job_id").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    source: varchar("source", { length: 16 }).notNull(),
    blockNumber: uint64("block_number"),
    blockHash: hash("block_hash"),
    txHash: hash("tx_hash"),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    canonical: boolean("canonical").notNull().default(true),
    orphanedAt: timestamp("orphaned_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.networkId, table.jobId],
      foreignColumns: [jobs.networkId, jobs.jobId],
    }).onDelete("cascade"),
    index("job_events_job_timeline_idx").on(
      table.networkId,
      table.jobId,
      table.occurredAt,
      table.id,
    ),
    index("job_events_canonical_block_idx")
      .on(table.networkId, table.canonical, table.blockNumber)
      .where(sql`${table.source} = 'indexed'`),
    check("job_events_source_ck", sql`${table.source} IN ('indexed', 'operational')`),
    check(
      "job_events_block_pair_ck",
      sql`(${table.blockNumber} IS NULL) = (${table.blockHash} IS NULL)`,
    ),
    check(
      "job_events_canonicality_ck",
      sql`(${table.canonical} AND ${table.orphanedAt} IS NULL) OR (NOT ${table.canonical} AND ${table.orphanedAt} IS NOT NULL)`,
    ),
  ],
);

export const transactionAttempts = pgTable(
  "transaction_attempts",
  {
    id: uuid("id").primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    jobId: hash("job_id"),
    operation: varchar("operation", { length: 24 }).notNull(),
    state: varchar("state", { length: 32 }).notNull(),
    unsignedTxHash: hash("unsigned_tx_hash"),
    txHash: hash("tx_hash"),
    errorCode: varchar("error_code", { length: 96 }),
    errorDetail: jsonb("error_detail"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    committedBlockNumber: uint64("committed_block_number"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.networkId, table.jobId],
      foreignColumns: [jobs.networkId, jobs.jobId],
    }).onDelete("restrict"),
    index("transaction_attempts_job_idx").on(table.networkId, table.jobId, table.createdAt),
    index("transaction_attempts_state_idx").on(table.networkId, table.state, table.updatedAt),
    uniqueIndex("transaction_attempts_network_tx_hash_uq")
      .on(table.networkId, table.txHash)
      .where(sql`${table.txHash} IS NOT NULL`),
    check(
      "transaction_attempts_operation_ck",
      sql`${table.operation} IN ('create', 'execute', 'cancel', 'recover', 'top_up')`,
    ),
    check(
      "transaction_attempts_state_ck",
      sql`${table.state} IN ('draft', 'awaiting_signature', 'submitted', 'proposed', 'committed', 'confirmed', 'conflicted', 'dropped', 'cancelled', 'recovery_required', 'reorged')`,
    ),
  ],
);

export const executorReceipts = pgTable(
  "executor_receipts",
  {
    id: uuid("id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => transactionAttempts.id, { onDelete: "cascade" }),
    executorLockHash: hash("executor_lock_hash").notNull(),
    payload: jsonb("payload").notNull(),
    signature: text("signature").notNull(),
    keyId: varchar("key_id", { length: 128 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("executor_receipts_attempt_uq").on(table.attemptId),
    check(
      "executor_receipts_executor_hash_ck",
      sql`${table.executorLockHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
  ],
);

export const notificationSubscriptions = pgTable(
  "notification_subscriptions",
  {
    id: uuid("id").primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    ownerLockHash: hash("owner_lock_hash").notNull(),
    channel: varchar("channel", { length: 16 }).notNull(),
    destinationCiphertext: text("destination_ciphertext").notNull(),
    eventTypes: jsonb("event_types").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("notification_subscriptions_owner_idx").on(table.networkId, table.ownerLockHash),
    check("notification_subscriptions_channel_ck", sql`${table.channel} IN ('email', 'webhook')`),
    check(
      "notification_subscriptions_event_types_ck",
      sql`jsonb_typeof(${table.eventTypes}) = 'array'`,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => notificationSubscriptions.id, { onDelete: "cascade" }),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => jobEvents.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    requestSignature: text("request_signature").notNull(),
    responseCode: integer("response_code"),
    responseExcerpt: text("response_excerpt"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_attempt_uq").on(
      table.subscriptionId,
      table.eventId,
      table.attemptNumber,
    ),
    index("webhook_deliveries_retry_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.deliveredAt} IS NULL AND ${table.nextAttemptAt} IS NOT NULL`),
    check("webhook_deliveries_attempt_number_ck", sql`${table.attemptNumber} > 0`),
    check(
      "webhook_deliveries_response_code_ck",
      sql`${table.responseCode} IS NULL OR ${table.responseCode} BETWEEN 100 AND 599`,
    ),
  ],
);

export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: uuid("id").primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    ownerLockHash: hash("owner_lock_hash").notNull(),
    nonceHash: varchar("nonce_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("auth_challenges_nonce_hash_uq").on(table.nonceHash),
    index("auth_challenges_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} IS NULL`),
    check("auth_challenges_nonce_hash_ck", sql`${table.nonceHash} ~ '^[0-9a-f]{64}$'`),
    check("auth_challenges_expiry_ck", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "auth_challenges_consumed_ck",
      sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const deadLetters = pgTable(
  "dead_letters",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    queue: varchar("queue", { length: 64 }).notNull(),
    jobKey: varchar("job_key", { length: 256 }).notNull(),
    reason: varchar("reason", { length: 128 }).notNull(),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull(),
    failedAt: timestamp("failed_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("dead_letters_unresolved_idx")
      .on(table.queue, table.failedAt)
      .where(sql`${table.resolvedAt} IS NULL`),
    check("dead_letters_attempts_ck", sql`${table.attempts} > 0`),
    check(
      "dead_letters_resolution_ck",
      sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.failedAt}`,
    ),
  ],
);

export const demoScenarios = pgTable(
  "demo_scenarios",
  {
    id: varchar("id", { length: 96 }).primaryKey(),
    networkId: varchar("network_id", { length: 64 })
      .notNull()
      .references(() => networks.id, { onDelete: "cascade" }),
    fixtureId: varchar("fixture_id", { length: 128 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("demo_scenarios_fixture_uq").on(table.networkId, table.fixtureId)],
);

export const schema = {
  authChallenges,
  canonicalBlocks,
  deadLetters,
  demoScenarios,
  executorReceipts,
  indexerCheckpoints,
  jobEvents,
  jobVersions,
  jobs,
  networks,
  notificationSubscriptions,
  scriptDeployments,
  transactionAttempts,
  webhookDeliveries,
} as const;
