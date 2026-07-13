BEGIN;

CREATE TABLE IF NOT EXISTS checkout_recoveries (
    id text PRIMARY KEY,
    checkout_session_id text UNIQUE,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    license_id text NOT NULL UNIQUE REFERENCES licenses(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    installation_id text NOT NULL,
    site_url text NOT NULL,
    expires_at timestamptz NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkout_recoveries_expiry_idx
    ON checkout_recoveries(expires_at)
    WHERE completed_at IS NULL;

COMMIT;
