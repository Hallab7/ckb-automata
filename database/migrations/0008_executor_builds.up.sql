ALTER TABLE transaction_attempts
  ADD COLUMN sequence numeric(20, 0) CHECK (
    sequence BETWEEN 0 AND 18446744073709551615
  ),
  ADD COLUMN chain_snapshot jsonb,
  ADD COLUMN intent_hash varchar(66) CHECK (
    intent_hash IS NULL OR intent_hash ~ '^0x[0-9a-f]{64}$'
  ),
  ADD COLUMN unsigned_transaction jsonb;

ALTER TABLE transaction_attempts
  ADD COLUMN build_claim_token uuid,
  ADD COLUMN build_claim_expires_at timestamptz,
  ADD CONSTRAINT transaction_attempts_build_claim_ck CHECK (
    (build_claim_token IS NULL) = (build_claim_expires_at IS NULL)
  );

CREATE UNIQUE INDEX transaction_attempts_active_execute_uq
  ON transaction_attempts (network_id, job_id, sequence)
  WHERE operation = 'execute'
    AND sequence IS NOT NULL
    AND state IN ('draft', 'submitted', 'proposed', 'committed', 'confirmed');

ALTER TABLE transaction_attempts
  ADD CONSTRAINT transaction_attempts_build_record_ck CHECK (
    (chain_snapshot IS NULL AND intent_hash IS NULL AND unsigned_transaction IS NULL)
    OR
    (chain_snapshot IS NOT NULL AND intent_hash IS NOT NULL AND unsigned_transaction IS NOT NULL)
  );
