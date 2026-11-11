CREATE TABLE dao_harvest_v3_events (
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  event_id varchar(160) NOT NULL,
  job_id varchar(66) NOT NULL,
  operation varchar(32) NOT NULL,
  transaction_hash varchar(66) NOT NULL,
  transaction_index numeric(10, 0) NOT NULL,
  block_number numeric(20, 0) NOT NULL,
  block_hash varchar(66) NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  projection jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  orphaned_at timestamptz,
  PRIMARY KEY (network_id, event_id),
  CONSTRAINT dao_harvest_v3_events_job_ck CHECK (job_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v3_events_tx_ck CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v3_events_block_ck CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v3_events_operation_ck CHECK (
    operation IN (
      'setup', 'preferred_prepare', 'fallback_prepare', 'preferred_claim',
      'fallback_claim', 'owner_complete', 'sweep', 'close', 'rotate',
      'owner_exit', 'owner_recovery'
    )
  ),
  CONSTRAINT dao_harvest_v3_events_canonicality_ck CHECK (
    (canonical AND orphaned_at IS NULL) OR (NOT canonical AND orphaned_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX dao_harvest_v3_events_chain_uq
  ON dao_harvest_v3_events(network_id, transaction_hash, transaction_index, operation);
CREATE INDEX dao_harvest_v3_events_rebuild_idx
  ON dao_harvest_v3_events(network_id, job_id, canonical, block_number, transaction_index);

CREATE TABLE dao_harvest_v3_jobs (
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  job_id varchar(66) NOT NULL,
  owner_lock_hash varchar(66) NOT NULL,
  lifecycle_state varchar(24) NOT NULL,
  projection jsonb NOT NULL,
  observed_block_number numeric(20, 0) NOT NULL,
  observed_block_hash varchar(66) NOT NULL,
  observed_transaction_hash varchar(66) NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, job_id),
  CONSTRAINT dao_harvest_v3_jobs_job_ck CHECK (job_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v3_jobs_owner_ck CHECK (owner_lock_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v3_jobs_block_ck CHECK (observed_block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v3_jobs_tx_ck CHECK (observed_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT dao_harvest_v3_jobs_state_ck CHECK (
    lifecycle_state IN ('deposited', 'withdrawing', 'completed', 'owner_withdrawing', 'recovered', 'closed')
  )
);

CREATE INDEX dao_harvest_v3_jobs_owner_idx
  ON dao_harvest_v3_jobs(network_id, owner_lock_hash, observed_block_number DESC);
CREATE INDEX dao_harvest_v3_jobs_state_idx
  ON dao_harvest_v3_jobs(network_id, lifecycle_state, observed_block_number DESC);
