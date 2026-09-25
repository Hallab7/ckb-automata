ALTER TABLE transaction_attempts
  DROP CONSTRAINT transaction_attempts_builder_lock_hash_ck,
  DROP COLUMN builder_lock_hash;
