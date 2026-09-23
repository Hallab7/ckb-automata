ALTER TABLE notification_subscriptions
  ADD COLUMN secret_version integer NOT NULL DEFAULT 1,
  ADD COLUMN next_replay_number integer NOT NULL DEFAULT 1,
  ADD COLUMN disabled_at timestamptz;

UPDATE notification_subscriptions
SET disabled_at = updated_at
WHERE NOT enabled;

ALTER TABLE notification_subscriptions
  DROP CONSTRAINT notification_subscriptions_event_types_check,
  ADD CONSTRAINT notification_subscriptions_event_types_check CHECK (
    jsonb_typeof(event_types) = 'array'
    AND jsonb_array_length(event_types) BETWEEN 1 AND 7
    AND event_types <@ '["ready", "submitted", "confirmed", "failed", "budget_low", "cancelled", "recovery_required"]'::jsonb
  ),
  ADD CONSTRAINT notification_subscriptions_secret_version_ck CHECK (secret_version > 0),
  ADD CONSTRAINT notification_subscriptions_next_replay_number_ck CHECK (
    next_replay_number > 0
  ),
  ADD CONSTRAINT notification_subscriptions_disabled_ck CHECK (
    (enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL)
  );

ALTER TABLE webhook_deliveries
  DROP CONSTRAINT webhook_deliveries_attempt_uq,
  ADD COLUMN replay_number integer NOT NULL DEFAULT 0,
  ADD COLUMN notification_type varchar(32),
  ADD COLUMN idempotency_key varchar(64),
  ADD COLUMN status varchar(24) NOT NULL DEFAULT 'pending',
  ADD COLUMN error_code varchar(64),
  ADD COLUMN finished_at timestamptz;

UPDATE webhook_deliveries AS delivery
SET
  notification_type = CASE
    WHEN event.event_type IN ('job_discovered', 'job_recurring', 'job_top_up') THEN 'ready'
    WHEN event.event_type = 'transaction_submitted' THEN 'submitted'
    WHEN event.event_type IN ('transaction_confirmed', 'execution_confirmed') THEN 'confirmed'
    WHEN event.event_type = 'job_cancelled' THEN 'cancelled'
    WHEN event.event_type = 'budget_low' THEN 'budget_low'
    WHEN event.event_type = 'recovery_required' THEN 'recovery_required'
    ELSE 'failed'
  END,
  idempotency_key = md5(
    delivery.subscription_id::text || ':' || delivery.event_id::text || ':0'
  ) || md5(
    'v1:' || delivery.subscription_id::text || ':' || delivery.event_id::text || ':0'
  ),
  status = CASE WHEN delivery.delivered_at IS NULL THEN 'failed' ELSE 'delivered' END,
  finished_at = COALESCE(delivery.delivered_at, delivery.created_at),
  next_attempt_at = NULL
FROM job_events AS event
WHERE event.id = delivery.event_id;

ALTER TABLE webhook_deliveries
  ALTER COLUMN notification_type SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ADD CONSTRAINT webhook_deliveries_attempt_uq UNIQUE (
    subscription_id,
    event_id,
    replay_number,
    attempt_number
  ),
  ADD CONSTRAINT webhook_deliveries_replay_number_ck CHECK (replay_number >= 0),
  ADD CONSTRAINT webhook_deliveries_idempotency_key_ck CHECK (
    idempotency_key ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT webhook_deliveries_notification_type_ck CHECK (
    notification_type IN (
      'ready',
      'submitted',
      'confirmed',
      'failed',
      'budget_low',
      'cancelled',
      'recovery_required'
    )
  ),
  ADD CONSTRAINT webhook_deliveries_status_ck CHECK (
    status IN ('pending', 'retry_scheduled', 'delivered', 'failed')
  ),
  ADD CONSTRAINT webhook_deliveries_terminal_ck CHECK (
    (status = 'pending' AND finished_at IS NULL AND next_attempt_at IS NULL)
    OR (status = 'retry_scheduled' AND finished_at IS NOT NULL AND next_attempt_at IS NOT NULL)
    OR (status IN ('delivered', 'failed') AND finished_at IS NOT NULL AND next_attempt_at IS NULL)
  ),
  ADD CONSTRAINT webhook_deliveries_delivered_ck CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status <> 'delivered' AND delivered_at IS NULL)
  );

CREATE INDEX webhook_deliveries_history_idx
  ON webhook_deliveries (subscription_id, created_at DESC, id DESC);
