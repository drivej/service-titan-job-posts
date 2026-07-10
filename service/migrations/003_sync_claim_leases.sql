BEGIN;

ALTER TABLE sites
    ADD COLUMN IF NOT EXISTS sync_claim_id text,
    ADD COLUMN IF NOT EXISTS sync_claimed_until timestamptz;

CREATE INDEX IF NOT EXISTS sites_sync_claimed_until_idx
    ON sites(sync_claimed_until);

COMMIT;
