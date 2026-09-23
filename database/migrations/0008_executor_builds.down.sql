ALTER TABLE transaction_attempts
  DROP CONSTRAINT transaction_attempts_build_record_ck;

ALTER TABLE transaction_attempts
  DROP CONSTRAINT transaction_attempts_build_claim_ck,
  DROP COLUMN build_claim_expires_at,
  DROP COLUMN build_claim_token;

DROP INDEX transaction_attempts_active_execute_uq;

ALTER TABLE transaction_attempts
  DROP COLUMN unsigned_transaction,
  DROP COLUMN intent_hash,
  DROP COLUMN chain_snapshot,
  DROP COLUMN sequence;
