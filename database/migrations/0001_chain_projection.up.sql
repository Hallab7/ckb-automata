CREATE TABLE networks (
  id varchar(64) PRIMARY KEY,
  genesis_hash varchar(66) NOT NULL UNIQUE,
  rpc_profile varchar(64) NOT NULL,
  confirmation_depth integer NOT NULL CHECK (confirmation_depth > 0),
  deployment_manifest_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT networks_genesis_hash_ck CHECK (genesis_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT networks_rpc_profile_ck CHECK (rpc_profile ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT networks_manifest_hash_ck CHECK (deployment_manifest_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE script_deployments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  name varchar(64) NOT NULL,
  code_hash varchar(66) NOT NULL CHECK (code_hash ~ '^0x[0-9a-f]{64}$'),
  hash_type varchar(8) NOT NULL CHECK (hash_type IN ('data', 'type', 'data1')),
  deployment_tx_hash varchar(66) NOT NULL CHECK (deployment_tx_hash ~ '^0x[0-9a-f]{64}$'),
  output_index numeric(10, 0) NOT NULL CHECK (output_index BETWEEN 0 AND 4294967295),
  dep_type varchar(10) NOT NULL CHECK (dep_type IN ('code', 'dep_group')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT script_deployments_network_name_uq UNIQUE (network_id, name)
);

CREATE TABLE indexer_checkpoints (
  network_id varchar(64) PRIMARY KEY REFERENCES networks(id) ON DELETE CASCADE,
  block_number numeric(20, 0) NOT NULL CHECK (block_number BETWEEN 0 AND 18446744073709551615),
  block_hash varchar(66) NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE canonical_blocks (
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  block_number numeric(20, 0) NOT NULL CHECK (block_number BETWEEN 0 AND 18446744073709551615),
  block_hash varchar(66) NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  parent_hash varchar(66) NOT NULL CHECK (parent_hash ~ '^0x[0-9a-f]{64}$'),
  block_timestamp numeric(20, 0) NOT NULL CHECK (block_timestamp BETWEEN 0 AND 18446744073709551615),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, block_number),
  CONSTRAINT canonical_blocks_network_hash_uq UNIQUE (network_id, block_hash)
);

CREATE INDEX canonical_blocks_network_height_idx
  ON canonical_blocks (network_id, block_number);

CREATE TABLE jobs (
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  job_id varchar(66) NOT NULL CHECK (job_id ~ '^0x[0-9a-f]{64}$'),
  outpoint_tx_hash varchar(66) NOT NULL CHECK (outpoint_tx_hash ~ '^0x[0-9a-f]{64}$'),
  outpoint_index numeric(10, 0) NOT NULL CHECK (outpoint_index BETWEEN 0 AND 4294967295),
  sequence numeric(20, 0) NOT NULL CHECK (sequence BETWEEN 0 AND 18446744073709551615),
  owner_lock_hash varchar(66) NOT NULL CHECK (owner_lock_hash ~ '^0x[0-9a-f]{64}$'),
  policy_script_hash varchar(66) NOT NULL CHECK (policy_script_hash ~ '^0x[0-9a-f]{64}$'),
  policy_kind varchar(32) NOT NULL,
  state varchar(24) NOT NULL CHECK (state IN ('live', 'spent', 'orphaned')),
  capacity numeric(20, 0) NOT NULL CHECK (capacity BETWEEN 0 AND 18446744073709551615),
  data bytea NOT NULL,
  block_number numeric(20, 0) NOT NULL CHECK (block_number BETWEEN 0 AND 18446744073709551615),
  block_hash varchar(66) NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_index numeric(10, 0) NOT NULL CHECK (transaction_index BETWEEN 0 AND 4294967295),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, job_id),
  CONSTRAINT jobs_network_outpoint_uq UNIQUE (network_id, outpoint_tx_hash, outpoint_index)
);

CREATE INDEX jobs_network_state_idx ON jobs (network_id, state, block_number);
CREATE INDEX jobs_owner_lock_hash_idx ON jobs (network_id, owner_lock_hash);

CREATE TABLE job_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network_id varchar(64) NOT NULL,
  job_id varchar(66) NOT NULL,
  sequence numeric(20, 0) NOT NULL CHECK (sequence BETWEEN 0 AND 18446744073709551615),
  outpoint_tx_hash varchar(66) NOT NULL CHECK (outpoint_tx_hash ~ '^0x[0-9a-f]{64}$'),
  outpoint_index numeric(10, 0) NOT NULL CHECK (outpoint_index BETWEEN 0 AND 4294967295),
  status varchar(24) NOT NULL CHECK (status IN ('live', 'spent', 'orphaned')),
  capacity numeric(20, 0) NOT NULL CHECK (capacity BETWEEN 0 AND 18446744073709551615),
  data bytea NOT NULL,
  observed_block_number numeric(20, 0) NOT NULL CHECK (observed_block_number BETWEEN 0 AND 18446744073709551615),
  observed_block_hash varchar(66) NOT NULL CHECK (observed_block_hash ~ '^0x[0-9a-f]{64}$'),
  spent_tx_hash varchar(66) CHECK (spent_tx_hash IS NULL OR spent_tx_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (network_id, job_id) REFERENCES jobs(network_id, job_id) ON DELETE CASCADE,
  CONSTRAINT job_versions_network_outpoint_uq UNIQUE (network_id, outpoint_tx_hash, outpoint_index),
  CONSTRAINT job_versions_network_job_sequence_uq UNIQUE (network_id, job_id, sequence)
);

CREATE INDEX job_versions_job_idx ON job_versions (network_id, job_id, sequence);

CREATE TABLE job_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network_id varchar(64) NOT NULL,
  job_id varchar(66) NOT NULL,
  event_type varchar(64) NOT NULL,
  source varchar(16) NOT NULL CHECK (source IN ('indexed', 'operational')),
  block_number numeric(20, 0) CHECK (block_number BETWEEN 0 AND 18446744073709551615),
  block_hash varchar(66) CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
  tx_hash varchar(66) CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (network_id, job_id) REFERENCES jobs(network_id, job_id) ON DELETE CASCADE,
  CONSTRAINT job_events_block_pair_ck CHECK ((block_number IS NULL) = (block_hash IS NULL))
);

CREATE INDEX job_events_job_timeline_idx
  ON job_events (network_id, job_id, occurred_at, id);
