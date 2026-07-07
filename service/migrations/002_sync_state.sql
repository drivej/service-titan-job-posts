BEGIN;

ALTER TABLE sites
    ADD COLUMN IF NOT EXISTS last_successful_sync_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_sync_attempt_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_sync_status text,
    ADD COLUMN IF NOT EXISTS last_sync_error text,
    ADD COLUMN IF NOT EXISTS last_sync_stats jsonb;

UPDATE sites
   SET last_sync_stats = '{}'::jsonb
 WHERE last_sync_stats IS NULL;

ALTER TABLE sites
    ALTER COLUMN last_sync_stats SET DEFAULT '{}'::jsonb,
    ALTER COLUMN last_sync_stats SET NOT NULL;

CREATE INDEX IF NOT EXISTS sites_last_successful_sync_at_idx
    ON sites(last_successful_sync_at);

COMMIT;
