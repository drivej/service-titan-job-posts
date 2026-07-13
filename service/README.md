# Hosted service

This service is the monetization and credential boundary for the WordPress
plugin. The plugin can be edited by a customer; this service cannot. Production
sync workers therefore fetch eligible sites from this service instead of asking
WordPress whether a subscription is valid.

## Responsibilities

- Activate a license for a normalized site origin.
- Store only hashes of license keys, checkout recovery tokens, and activation
  tokens.
- Create Stripe Checkout sessions with server-configured monthly/yearly prices.
- Isolate every unauthenticated checkout in a new billing account, so knowledge
  of an existing subscriber's email cannot mint a license against their paid
  entitlement.
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
  subscription state, and ignore older delayed subscription events so they
  cannot restore access after a newer cancellation.
- Reconcile signed subscription webhooks against Stripe's current subscription
  object before applying them, resolving same-second pause/resume events without
  weakening fail-closed ordering. Authoritative reconciled snapshots supersede
  local event timestamps and receive a database-issued monotonic sequence so
  concurrent handlers cannot commit them out of retrieval order. Completed
  duplicate events skip the Stripe API call while transactional deduplication
  remains in place for concurrent requests.
- Commit webhook deduplication and subscription updates in one transaction so a
  storage failure remains safely retryable instead of losing the billing event.

Old WordPress posts are never deleted or hidden by this service. Eligibility
requires an `active` or `trialing` Stripe status, no `pause_collection`, and a
valid future paid-through date. If a subscription becomes canceled, unpaid,
paused, expired, malformed, or otherwise ineligible, the site simply stops
appearing in sync claims.

## HTTP contract

Billing endpoints:

- `POST /v1/billing/checkout` creates an isolated account, unissued license,
  Stripe customer, subscription Checkout Session, and 24-hour recovery token
  bound to the requesting WordPress origin and installation. It returns the
  token once, but no license key before payment.
- `POST /v1/billing/checkout/recover` verifies the bound Checkout Session and
  current subscription directly with Stripe, then deterministically reissues
  the same recoverable license without storing its plaintext. Recovery remains
  fail-closed until Stripe reports an eligible monthly or yearly subscription.
- `POST /v1/billing/portal` creates a Stripe Billing Portal session using either
  a license key or a connected site's bearer activation token.

Plugin-facing endpoints:

- `POST /v1/licenses/activate`
- `GET /v1/licenses/status` returns entitlement, safe ServiceTitan connection
  status, and hosted sync health: last successful sync, last attempt, last
  status, last error, and last run totals.
- `DELETE /v1/licenses/activation`
- `PUT /v1/connections/servicetitan`
- `PUT /v1/sites/policy`

Worker-facing endpoint:

- `POST /internal/v1/sync/claims` with `Authorization: Bearer <WORKER_API_KEY>`
  accepts only `limit: 1` and returns one eligible site with a `claim_id`, a
  `sync_claimed_until` lease, and a server-issued `run_started_at`. The worker
  echoes that timestamp while draining later singleton batches. Sites already
  attempted during that run and sites with an active lease are omitted.
- `POST /internal/v1/sync/authorize` with worker authentication, `site_id`, and
  `claim_id` rechecks the live lease and subscription immediately before each
  WordPress delivery. A denial fails closed without creating a post.
- `POST /internal/v1/sync/runs` with `Authorization: Bearer <WORKER_API_KEY>`
  records a site's sync result. The worker should echo the `claim_id` it
  received. Reports mutate health and cursor state only while that exact claim
  is still current; stale workers receive `409 stale_sync_claim`. Successful
  runs advance the site's cursor monotonically, failed runs preserve the
  previous cursor for a safe retry, and accepted reports release the lease.

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

CI also applies every migration to a disposable PostgreSQL 16 database and runs
`npm run test:postgres`, covering claim-bound run reports, concurrent singleton
claims, and checkout recovery against the production store rather than only the
in-memory test store.
