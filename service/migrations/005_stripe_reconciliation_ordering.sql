BEGIN;

CREATE SEQUENCE IF NOT EXISTS stripe_reconciliation_sequence;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS stripe_reconciliation_sequence bigint;

COMMIT;
