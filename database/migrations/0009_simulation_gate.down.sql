ALTER TABLE transaction_attempts
  DROP COLUMN simulation;

DROP INDEX transaction_attempts_active_execute_uq;

CREATE UNIQUE INDEX transaction_attempts_active_execute_uq
  ON transaction_attempts (network_id, job_id, sequence)
  WHERE operation = 'execute'
    AND sequence IS NOT NULL
    AND state IN ('draft', 'submitted', 'proposed', 'committed', 'confirmed');
