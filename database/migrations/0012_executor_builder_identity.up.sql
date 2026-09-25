ALTER TABLE transaction_attempts
  ADD COLUMN builder_lock_hash varchar(66),
  ADD CONSTRAINT transaction_attempts_builder_lock_hash_ck CHECK (
    builder_lock_hash IS NULL OR builder_lock_hash ~ '^0x[0-9a-f]{64}$'
  );
