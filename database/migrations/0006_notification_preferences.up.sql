CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY,
  network_id varchar(64) NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  owner_lock_hash varchar(66) NOT NULL CHECK (owner_lock_hash ~ '^0x[0-9a-f]{64}$'),
  channel varchar(16) NOT NULL CHECK (channel IN ('browser', 'email')),
  event_types jsonb NOT NULL CHECK (
    jsonb_typeof(event_types) = 'array'
    AND jsonb_array_length(event_types) <= 7
    AND event_types <@ '["ready", "submitted", "confirmed", "failed", "budget_low", "cancelled", "recovery_required"]'::jsonb
  ),
  destination_ciphertext text,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_owner_channel_uq UNIQUE (
    network_id,
    owner_lock_hash,
    channel
  ),
  CONSTRAINT notification_preferences_destination_ck CHECK (
    (channel = 'browser' AND destination_ciphertext IS NULL)
    OR channel = 'email'
  ),
  CONSTRAINT notification_preferences_enabled_ck CHECK (
    NOT enabled OR jsonb_array_length(event_types) > 0
  ),
  CONSTRAINT notification_preferences_email_enabled_ck CHECK (
    channel <> 'email' OR NOT enabled OR destination_ciphertext IS NOT NULL
  )
);

CREATE INDEX notification_preferences_owner_idx
  ON notification_preferences (network_id, owner_lock_hash);
