BEGIN;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS stripe_event_created bigint;

COMMIT;
