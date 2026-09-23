CREATE UNIQUE INDEX dead_letters_queue_job_uq
  ON dead_letters (queue, job_key);

CREATE TABLE dead_letter_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dead_letter_id bigint NOT NULL REFERENCES dead_letters(id) ON DELETE CASCADE,
  action varchar(16) NOT NULL CHECK (action IN ('inspect', 'replay', 'close')),
  operator varchar(128) NOT NULL CHECK (operator ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{1,127}$'),
  reason varchar(512),
  replay_job_id varchar(256),
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dead_letter_actions_reason_ck CHECK (
    (action = 'inspect' AND reason IS NULL) OR
    (action IN ('replay', 'close') AND reason IS NOT NULL AND length(reason) BETWEEN 8 AND 512)
  ),
  CONSTRAINT dead_letter_actions_replay_job_ck CHECK (
    (action = 'replay' AND replay_job_id IS NOT NULL) OR
    (action <> 'replay' AND replay_job_id IS NULL)
  ),
  CONSTRAINT dead_letter_actions_dispatch_ck CHECK (
    action = 'replay' OR dispatched_at IS NULL
  )
);

CREATE INDEX dead_letter_actions_timeline_idx
  ON dead_letter_actions (dead_letter_id, id);
CREATE UNIQUE INDEX dead_letter_actions_replay_uq
  ON dead_letter_actions (dead_letter_id)
  WHERE action = 'replay';
CREATE UNIQUE INDEX dead_letter_actions_close_uq
  ON dead_letter_actions (dead_letter_id)
  WHERE action = 'close';
