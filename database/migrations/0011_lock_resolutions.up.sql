CREATE TABLE lock_resolutions (
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  lock_hash varchar(66) NOT NULL,
  code_hash varchar(66) NOT NULL,
  hash_type varchar(5) NOT NULL,
  args text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, lock_hash),
  CONSTRAINT lock_resolutions_lock_hash_ck CHECK (lock_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT lock_resolutions_code_hash_ck CHECK (code_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT lock_resolutions_hash_type_ck CHECK (hash_type IN ('data', 'type', 'data1')),
  CONSTRAINT lock_resolutions_args_ck CHECK (args ~ '^0x(?:[0-9a-f]{2})*$')
);
