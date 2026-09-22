DROP INDEX job_events_canonical_block_idx;

ALTER TABLE job_events
  DROP CONSTRAINT job_events_canonicality_ck,
  DROP COLUMN orphaned_at,
  DROP COLUMN canonical;

ALTER TABLE job_versions
  DROP COLUMN transaction_index;
