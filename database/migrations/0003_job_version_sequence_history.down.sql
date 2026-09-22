ALTER TABLE job_versions
  ADD CONSTRAINT job_versions_network_job_sequence_uq
  UNIQUE (network_id, job_id, sequence);
