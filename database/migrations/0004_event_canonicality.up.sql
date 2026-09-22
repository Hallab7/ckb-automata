ALTER TABLE job_versions
  ADD COLUMN transaction_index numeric(10, 0) NOT NULL DEFAULT 0,
  ADD CONSTRAINT job_versions_transaction_index_ck
  CHECK (transaction_index BETWEEN 0 AND 4294967295);

UPDATE job_versions AS history
SET transaction_index = current.transaction_index
FROM jobs AS current
WHERE current.network_id = history.network_id
  AND current.job_id = history.job_id
  AND current.outpoint_tx_hash = history.outpoint_tx_hash
  AND current.outpoint_index = history.outpoint_index;

ALTER TABLE job_events
  ADD COLUMN canonical boolean NOT NULL DEFAULT true,
  ADD COLUMN orphaned_at timestamptz,
  ADD CONSTRAINT job_events_canonicality_ck CHECK (
    (canonical AND orphaned_at IS NULL)
    OR (NOT canonical AND orphaned_at IS NOT NULL)
  );

CREATE INDEX job_events_canonical_block_idx
  ON job_events (network_id, canonical, block_number)
  WHERE source = 'indexed';
