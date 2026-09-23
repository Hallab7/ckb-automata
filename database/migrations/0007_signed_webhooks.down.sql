DROP INDEX webhook_deliveries_history_idx;

DELETE FROM webhook_deliveries WHERE replay_number > 0;

ALTER TABLE webhook_deliveries
  DROP CONSTRAINT webhook_deliveries_delivered_ck,
  DROP CONSTRAINT webhook_deliveries_terminal_ck,
  DROP CONSTRAINT webhook_deliveries_status_ck,
  DROP CONSTRAINT webhook_deliveries_notification_type_ck,
  DROP CONSTRAINT webhook_deliveries_replay_number_ck,
  DROP CONSTRAINT webhook_deliveries_idempotency_key_ck,
  DROP CONSTRAINT webhook_deliveries_attempt_uq,
  ADD CONSTRAINT webhook_deliveries_attempt_uq UNIQUE (
    subscription_id,
    event_id,
    attempt_number
  ),
  DROP COLUMN finished_at,
  DROP COLUMN error_code,
  DROP COLUMN status,
  DROP COLUMN idempotency_key,
  DROP COLUMN notification_type,
  DROP COLUMN replay_number;

ALTER TABLE notification_subscriptions
  DROP CONSTRAINT notification_subscriptions_disabled_ck,
  DROP CONSTRAINT notification_subscriptions_next_replay_number_ck,
  DROP CONSTRAINT notification_subscriptions_secret_version_ck,
  DROP CONSTRAINT notification_subscriptions_event_types_check,
  ADD CONSTRAINT notification_subscriptions_event_types_check CHECK (
    jsonb_typeof(event_types) = 'array'
  ),
  DROP COLUMN disabled_at,
  DROP COLUMN next_replay_number,
  DROP COLUMN secret_version;
