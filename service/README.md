# Hosted service

This service is the monetization and credential boundary for the WordPress
plugin. The plugin can be edited by a customer; this service cannot. Production
sync workers therefore fetch eligible sites from this service instead of asking
WordPress whether a subscription is valid.

## Responsibilities

- Activate a license for a normalized site origin.
- Store only hashes of license keys and activation tokens.
- Create Stripe Checkout sessions with server-configured monthly/yearly prices.
- Encrypt per-site ServiceTitan credentials and WordPress delivery signing
  secrets with AES-256-GCM.
- Derive entitlement from server-side subscription state.
- Expose only active/trialing sites to the worker through
  `POST /internal/v1/sync/claims`.
- Track each site's successful sync cursor in the hosted service so daily runs
  resume from the last fully processed ServiceTitan modification window.
- Lease claimed sites for 30 minutes so overlapping worker processes do not
  duplicate ServiceTitan API work for the same customer site.
- Validate Stripe webhook signatures from the raw request body before updating
  subscription state.

Old WordPress posts are never deleted or hidden by this service. If a
subscription becomes canceled, unpaid, paused, or otherwise ineligible, the
site simply stops appearing in sync claims.

## HTTP contract

Billing endpoints:

- `POST /v1/billing/checkout` creates an account, a one-time license key, a
  Stripe customer, and a subscription Checkout Session. The license key is
  returned once, but it cannot activate a site until Stripe webhooks mark the
  subscription `active` or `trialing`.
- `POST /v1/billing/portal` creates a Stripe Billing Portal session using either
  a license key or a connected site's bearer activation token.

Plugin-facing endpoints:

- `POST /v1/licenses/activate`
- `GET /v1/licenses/status` returns entitlement plus hosted sync health:
  last successful sync, last attempt, last status, last error, and last run
  totals.
- `DELETE /v1/licenses/activation`
- `PUT /v1/connections/servicetitan`
- `PUT /v1/sites/policy`

Worker-facing endpoint:

- `POST /internal/v1/sync/claims` with `Authorization: Bearer <WORKER_API_KEY>`
  returns eligible sites with a `claim_id` and `sync_claimed_until` lease. A
  currently leased site is omitted until the lease expires or the worker reports
  a run result.
- `POST /internal/v1/sync/runs` with `Authorization: Bearer <WORKER_API_KEY>`
  records a site's sync result. The worker should echo the `claim_id` it
  received. Successful runs advance the site's cursor monotonically; failed
  runs preserve the previous cursor for a safe retry. Matching run reports
  release the active lease.

Stripe endpoint:

- `POST /v1/stripe/webhooks` with the raw JSON body and `Stripe-Signature`
  header.

## Environment

```dotenv
PORT=8080
DATABASE_URL=postgres://...
SERVICE_ENCRYPTION_KEY=base64-or-hex-32-byte-key
WORKER_API_KEY=worker-secret
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_MONTHLY_PRICE_ID=price_monthly
STRIPE_YEARLY_PRICE_ID=price_yearly
STRIPE_CHECKOUT_SUCCESS_URL=https://example.com/checkout/success
STRIPE_CHECKOUT_CANCEL_URL=https://example.com/checkout/cancel
STRIPE_PORTAL_RETURN_URL=https://example.com/account
DEFAULT_SITE_LIMIT=1
ALLOW_INSECURE_LOCAL_DELIVERY=false
```

For local development only, `src/server.js` can seed one in-memory license:

```dotenv
DEV_LICENSE_KEY=LOCAL-DEMO-LICENSE
DEV_SUBSCRIPTION_STATUS=active
DEV_CURRENT_PERIOD_END=2099-01-01T00:00:00.000Z
```

Production should apply the SQL files in `migrations/` to PostgreSQL and set
`DATABASE_URL`. Without `DATABASE_URL`, the server starts the in-memory
development store only.

## Migrations and deploy

Run database migrations before starting the service:

```bash
npm ci
npm run migrate
npm start
```

The included Dockerfile packages the service runtime:

```bash
docker build -t service-titan-job-post-service .
docker run --env-file .env -p 8080:8080 service-titan-job-post-service
```

Production startup validates required secrets and Stripe URLs before listening.
Set `PGSSLMODE=disable` only for trusted local databases. Use
`PGSSLMODE=no-verify` only when your host requires TLS without certificate
verification.

Use `GET /health` for process liveness and `GET /ready` for dependency
readiness. In production, `/ready` checks PostgreSQL connectivity and confirms
the latest migration has been recorded by `npm run migrate`.

## Test

```bash
npm test
```
