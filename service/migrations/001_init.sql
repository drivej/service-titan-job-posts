BEGIN;

CREATE TABLE IF NOT EXISTS accounts (
    id text PRIMARY KEY,
    email text,
    stripe_customer_id text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS accounts_email_idx ON accounts(lower(email));

CREATE TABLE IF NOT EXISTS licenses (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    key_hash text NOT NULL UNIQUE,
    key_last4 text,
    active boolean NOT NULL DEFAULT true,
    site_limit integer NOT NULL DEFAULT 1 CHECK (site_limit > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
    account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    stripe_subscription_id text UNIQUE,
    stripe_customer_id text,
    status text NOT NULL,
    price_id text,
    current_period_end timestamptz,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions(status);

CREATE TABLE IF NOT EXISTS sites (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    license_id text NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    site_url text NOT NULL,
    installation_id text NOT NULL,
    delivery_url text NOT NULL,
    plugin_version text,
    activation_token_hash text NOT NULL UNIQUE,
    signing_secret_encrypted jsonb NOT NULL,
    policy jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS sites_license_installation_active_idx
    ON sites(license_id, installation_id)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sites_license_origin_active_idx
    ON sites(license_id, site_url)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS servicetitan_connections (
    site_id text PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
    tenant_id text NOT NULL,
    environment text NOT NULL CHECK (environment IN ('production', 'integration')),
    client_id_encrypted jsonb NOT NULL,
    client_secret_encrypted jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    id text PRIMARY KEY,
    type text NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_claim_runs (
    id bigserial PRIMARY KEY,
    claimed_site_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
