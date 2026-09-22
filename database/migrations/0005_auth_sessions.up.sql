CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  owner_lock_hash varchar(66) NOT NULL CHECK (owner_lock_hash ~ '^0x[0-9a-f]{64}$'),
  token_hash varchar(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scope varchar(32) NOT NULL CHECK (scope = 'off_chain_settings'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT auth_sessions_revoked_ck CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX auth_sessions_token_active_idx
  ON auth_sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX auth_sessions_owner_idx
  ON auth_sessions (network_id, owner_lock_hash, created_at);
