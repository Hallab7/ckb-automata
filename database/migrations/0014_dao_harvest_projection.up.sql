CREATE TABLE dao_harvest_jobs (
  network_id varchar(64) NOT NULL,
  job_id varchar(66) NOT NULL,
  vault_outpoint_tx_hash varchar(66) NOT NULL CHECK (vault_outpoint_tx_hash ~ '^0x[0-9a-f]{64}$'),
  vault_outpoint_index numeric(10, 0) NOT NULL CHECK (vault_outpoint_index BETWEEN 0 AND 4294967295),
  vault_state varchar(24) NOT NULL CHECK (vault_state IN ('deposited', 'withdrawing', 'claim_ready', 'completed', 'recovery_required')),
  deposit_epoch_since numeric(20, 0) NOT NULL CHECK (deposit_epoch_since BETWEEN 0 AND 18446744073709551615),
  prepare_start_since numeric(20, 0) NOT NULL CHECK (prepare_start_since BETWEEN 0 AND 18446744073709551615),
  prepare_cutoff_since numeric(20, 0) NOT NULL CHECK (prepare_cutoff_since BETWEEN 0 AND 18446744073709551615),
  claim_maturity_since numeric(20, 0) CHECK (claim_maturity_since BETWEEN 0 AND 18446744073709551615),
  prepare_block_hash varchar(66) CHECK (prepare_block_hash IS NULL OR prepare_block_hash ~ '^0x[0-9a-f]{64}$'),
  prepare_block_number numeric(20, 0) CHECK (prepare_block_number BETWEEN 0 AND 18446744073709551615),
  completed_cycles numeric(10, 0) NOT NULL DEFAULT 0 CHECK (completed_cycles BETWEEN 0 AND 4294967295),
  total_cycles numeric(10, 0) NOT NULL CHECK (total_cycles BETWEEN 1 AND 4294967295),
  principal_capacity numeric(20, 0) NOT NULL CHECK (principal_capacity BETWEEN 0 AND 18446744073709551615),
  payout_lock_hash varchar(66) NOT NULL CHECK (payout_lock_hash ~ '^0x[0-9a-f]{64}$'),
  economics_snapshot jsonb NOT NULL,
  payload bytea NOT NULL,
  observed_block_number numeric(20, 0) NOT NULL CHECK (observed_block_number BETWEEN 0 AND 18446744073709551615),
  observed_block_hash varchar(66) NOT NULL CHECK (observed_block_hash ~ '^0x[0-9a-f]{64}$'),
  canonical boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, job_id),
  FOREIGN KEY (network_id, job_id) REFERENCES jobs(network_id, job_id) ON DELETE CASCADE,
  CONSTRAINT dao_harvest_jobs_vault_uq UNIQUE (network_id, vault_outpoint_tx_hash, vault_outpoint_index),
  CONSTRAINT dao_harvest_jobs_prepare_header_pair_ck CHECK ((prepare_block_hash IS NULL) = (prepare_block_number IS NULL)),
  CONSTRAINT dao_harvest_jobs_economics_ck CHECK (jsonb_typeof(economics_snapshot) = 'object')
);

CREATE INDEX dao_harvest_jobs_state_schedule_idx
  ON dao_harvest_jobs (network_id, vault_state, prepare_start_since, claim_maturity_since);

CREATE TABLE dao_harvest_transition_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network_id varchar(64) NOT NULL,
  job_id varchar(66) NOT NULL,
  sequence numeric(20, 0) NOT NULL CHECK (sequence BETWEEN 0 AND 18446744073709551615),
  operation varchar(24) NOT NULL CHECK (operation IN ('setup', 'prepare', 'roll', 'stop', 'exit', 'recover')),
  state varchar(24) NOT NULL CHECK (state IN ('ready', 'submitted', 'committed', 'confirmed', 'conflicted', 'dropped', 'reorged', 'failed')),
  tx_hash varchar(66) CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number numeric(20, 0) CHECK (block_number BETWEEN 0 AND 18446744073709551615),
  block_hash varchar(66) CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  canonical boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (network_id, job_id) REFERENCES dao_harvest_jobs(network_id, job_id) ON DELETE CASCADE,
  CONSTRAINT dao_harvest_attempts_block_pair_ck CHECK ((block_number IS NULL) = (block_hash IS NULL)),
  CONSTRAINT dao_harvest_attempts_evidence_ck CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE UNIQUE INDEX dao_harvest_attempts_tx_uq
  ON dao_harvest_transition_attempts (network_id, tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE INDEX dao_harvest_attempts_job_idx
  ON dao_harvest_transition_attempts (network_id, job_id, sequence, created_at);
