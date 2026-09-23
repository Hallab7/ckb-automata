DROP INDEX transaction_attempts_active_execute_uq;

CREATE UNIQUE INDEX transaction_attempts_active_execute_uq
  ON transaction_attempts (network_id, job_id, sequence)
  WHERE operation = 'execute'
    AND sequence IS NOT NULL
    AND state IN (
      'draft',
      'awaiting_signature',
      'submitted',
      'proposed',
      'committed',
      'confirmed'
    );

ALTER TABLE transaction_attempts
  ADD COLUMN simulation jsonb;
