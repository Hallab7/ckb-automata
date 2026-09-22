CREATE TABLE transaction_attempts (
  id uuid PRIMARY KEY,
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  job_id varchar(66),
  operation varchar(24) NOT NULL CHECK (operation IN ('create', 'execute', 'cancel', 'recover', 'top_up')),
  state varchar(32) NOT NULL CHECK (
    state IN (
      'draft',
      'awaiting_signature',
      'submitted',
      'proposed',
      'committed',
      'confirmed',
      'conflicted',
      'dropped',
      'cancelled',
      'recovery_required',
      'reorged'
    )
  ),
  unsigned_tx_hash varchar(66) CHECK (unsigned_tx_hash IS NULL OR unsigned_tx_hash ~ '^0x[0-9a-f]{64}$'),
  tx_hash varchar(66) CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  error_code varchar(96),
  error_detail jsonb,
  submitted_at timestamptz,
  committed_block_number numeric(20, 0) CHECK (
    committed_block_number BETWEEN 0 AND 18446744073709551615
  ),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (network_id, job_id) REFERENCES jobs(network_id, job_id) ON DELETE RESTRICT
);

CREATE INDEX transaction_attempts_job_idx
  ON transaction_attempts (network_id, job_id, created_at);
CREATE INDEX transaction_attempts_state_idx
  ON transaction_attempts (network_id, state, updated_at);
CREATE UNIQUE INDEX transaction_attempts_network_tx_hash_uq
  ON transaction_attempts (network_id, tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE TABLE executor_receipts (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE REFERENCES transaction_attempts(id) ON DELETE CASCADE,
  executor_lock_hash varchar(66) NOT NULL CHECK (executor_lock_hash ~ '^0x[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  signature text NOT NULL,
  key_id varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_subscriptions (
  id uuid PRIMARY KEY,
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  owner_lock_hash varchar(66) NOT NULL CHECK (owner_lock_hash ~ '^0x[0-9a-f]{64}$'),
  channel varchar(16) NOT NULL CHECK (channel IN ('email', 'webhook')),
  destination_ciphertext text NOT NULL,
  event_types jsonb NOT NULL CHECK (jsonb_typeof(event_types) = 'array'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_subscriptions_owner_idx
  ON notification_subscriptions (network_id, owner_lock_hash);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES notification_subscriptions(id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES job_events(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  request_signature text NOT NULL,
  response_code integer CHECK (response_code BETWEEN 100 AND 599),
  response_excerpt text,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_attempt_uq UNIQUE (subscription_id, event_id, attempt_number)
);

CREATE INDEX webhook_deliveries_retry_idx
  ON webhook_deliveries (next_attempt_at)
  WHERE delivered_at IS NULL AND next_attempt_at IS NOT NULL;

CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY,
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  owner_lock_hash varchar(66) NOT NULL CHECK (owner_lock_hash ~ '^0x[0-9a-f]{64}$'),
  nonce_hash varchar(64) NOT NULL UNIQUE CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_challenges_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT auth_challenges_consumed_ck CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX auth_challenges_expiry_idx
  ON auth_challenges (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE dead_letters (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue varchar(64) NOT NULL,
  job_key varchar(256) NOT NULL,
  reason varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  failed_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dead_letters_resolution_ck CHECK (resolved_at IS NULL OR resolved_at >= failed_at)
);

CREATE INDEX dead_letters_unresolved_idx
  ON dead_letters (queue, failed_at)
  WHERE resolved_at IS NULL;

CREATE TABLE demo_scenarios (
  id varchar(96) PRIMARY KEY,
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  fixture_id varchar(128) NOT NULL,
  label varchar(160) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demo_scenarios_fixture_uq UNIQUE (network_id, fixture_id)
);
