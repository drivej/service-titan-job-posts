# ServiceTitan Local Job Content

A WordPress plugin and scheduled Node.js worker that turn completed ServiceTitan
jobs into privacy-conscious, locally relevant website content.

## What it does

1. The worker requests completed ServiceTitan jobs and paginates through every
   result.
2. It enriches each job with its Job Type and CRM Location.
3. It filters jobs by price, city, job type, completion state, and verified
   completion-detail quality.
4. It removes known customer names, exact addresses, email addresses, phone
   numbers, and links from generated copy.
5. It classifies the job as plumbing, HVAC, electrical, or a configured service.
6. WordPress creates the job as **Pending Review** and assigns service/location
   terms.
7. An editor reviews and publishes the post.
8. The Recent Local Jobs block shows the newest approved jobs on the matching
   service/location page.

The worker never sends a publish status. WordPress enforces the review queue.
Later syncs preserve editorial copy on published posts.

## URL and page model

Create ordinary nested WordPress Pages:

```text
Plumbing              /plumbing/
└── Newark             /plumbing/newark/
```

Add the **Recent Local Jobs** block to the Newark page. With its service and
location fields blank, the block infers `plumbing` and `newark` from the page
hierarchy. You can set the slugs explicitly when a site's page structure is
different.

Approved job posts are nested beneath that path:

```text
/plumbing/newark/job/job-123/
```

The block shows three jobs by default. The count is configurable globally and
per block. Pending jobs never appear.

## WordPress installation

1. Copy this directory to `wp-content/plugins/service-titan-job-post`.
2. Configure the hosted service URL in the plugin build with
   `ST_SYNC_SERVICE_URL` or the `st_sync_service_url` filter.
3. Activate **ServiceTitan Local Job Content**.
4. Use a non-Plain permalink structure.
5. Open **Local Jobs Sync** in the WordPress admin.
6. Activate the site with its subscription license.
7. Send ServiceTitan tenant/client credentials to the hosted service.
8. Configure content filters and service mappings.

Once activated, the Subscription panel includes a **Manage billing** button that
opens the hosted Stripe Billing Portal. Canceling there stops future sync claims
after Stripe webhooks update the hosted subscription state; existing WordPress
job posts remain untouched.

Required ServiceTitan application scopes:

- Job Planning and Management → Jobs (Read)
- Job Planning and Management → Job Types (Read)
- CRM → Locations (Read)

### Service mappings

Automatic classification recognizes common plumbing, HVAC, and electrical
terms. Explicit mappings take precedence. Stable ServiceTitan Job Type IDs are
preferred:

```text
123456=plumbing
234567=hvac
345678=electrical
```

The left side can also match a Job Type name or class. The right side is the
service-page slug. Unknown jobs are held back unless a default service is
explicitly configured.

Only ServiceTitan **Summary of Work** is treated as completion evidence by
default. Because that field is not enabled for every account, you can configure
a vetted technician-completion custom field by name or type ID. Booking
summaries and Job Type boilerplate are deliberately not converted into public
claims about completed work.

## Hosted service

The `service/` package is the subscription, activation, and credential boundary.
It stores license keys and activation tokens as hashes, encrypts ServiceTitan
credentials and WordPress delivery signing secrets, validates Stripe webhook
signatures, and returns only eligible sites to the worker.
It also owns each site's sync cursor: the first hosted claim uses the configured
initial backfill date, and later claims resume from the last successful worker
run with a small overlap for safety.

Checkout creates a Stripe subscription session and returns a one-time license
key, but that key cannot activate a WordPress site until a signed Stripe webhook
updates the server-side subscription to `active` or `trialing`.

Eligible means the server-side subscription is `active` or `trialing`. Canceled,
unpaid, paused, past-due, incomplete, and revoked activations do not appear in
worker sync claims. Existing WordPress job posts are not gated by entitlement and
remain on the customer's site.

```bash
cd service
npm test
npm start
```

See `service/README.md` and `service/migrations/001_init.sql` for the HTTP
contract and database schema.

## Worker configuration

The `sevalla/` process is the hosted ingestion worker, not customer-shipped
code. In production it asks the hosted service for eligible sync claims:

```dotenv
DEV_MODE=false
SERVICE_URL=https://sync-service.example.com
WORKER_API_KEY=server-side-worker-secret
ST_APP_KEY=ak1.example
```

For isolated one-site development, copy `.env.example` to `.env` and set:

```dotenv
DEV_MODE=false
STANDALONE_SYNC=true
WP_URL=https://example.com
SITE_ID=site_identifier_from_activation
SITE_SIGNING_SECRET=per_site_delivery_secret
ST_TENANT_ID=123456
ST_CLIENT_ID=...
ST_CLIENT_SECRET=...
```

Production ServiceTitan credentials are encrypted in the hosted service. They
are never fetched from a customer-editable PHP endpoint. WordPress accepts jobs
only when their exact JSON body is signed with the provisioned per-site secret.
The hosted service supplies the ServiceTitan modified-date window for each
eligible site and advances it only after the worker reports a successful run.

Install and run:

```bash
npm ci
npm test
npm start
```

The worker is intentionally a one-shot process. Schedule `npm start` daily in
Sevalla, cron, or another job runner. The included Dockerfile runs that same
one-shot command.

Set `DEV_MODE=true` to use `mock-jobs.json` instead of calling ServiceTitan. Dev
mode still sends the resulting jobs to the configured WordPress site.

## Editorial workflow

Imported content appears under **Local Jobs** with a Pending status. Reviewers
should verify:

- the copy accurately describes the work;
- no customer-identifying information remains;
- the service and location terms are correct;
- the post is useful and distinct enough to publish.

Publishing makes the job eligible for location-page blocks and the normal
WordPress sitemap. Uninstalling removes credentials and plugin settings but
preserves job posts and editorial content.

## Validation

Run the repo-level validation script before committing:

```bash
sh scripts/validate.sh
```

It checks worker syntax/tests, hosted service syntax/tests, PHP lint, and Git
whitespace. If `WP_ROOT` points at a disposable WordPress install, it also runs
the integration test:

```bash
WP_ROOT="/path/to/wordpress" php tests/wordpress-integration.php
```

GitHub Actions runs the same non-WordPress checks on push and pull request.

## Release packaging

Build the customer-installable WordPress plugin zip with:

```bash
sh scripts/build-plugin-zip.sh
```

The zip is written to `dist/service-titan-job-post.zip` and includes only the
WordPress plugin runtime: PHP files, block assets, and plugin docs. It
deliberately excludes the hosted service, Sevalla worker, tests, local
environment files, and dependency folders.

## Security notes

- Keep `.env` out of version control; it is ignored by this repository.
- Use HTTPS for WordPress and never disable TLS certificate verification.
- Do not ship ServiceTitan credentials or the worker API key in the WordPress
  plugin.
- Treat `SERVICE_ENCRYPTION_KEY`, `WORKER_API_KEY`, Stripe secrets, and
  ServiceTitan credentials as hosted-service secrets.
- Generated redaction is a safeguard, not a substitute for pending-review
  editorial checks.
