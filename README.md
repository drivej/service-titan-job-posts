# ServiceTitan Local Job Content

A WordPress plugin and scheduled Node.js worker that turn completed ServiceTitan
jobs into privacy-conscious, locally relevant website content.

## What it does

1. The worker requests completed ServiceTitan jobs and paginates through every
   result.
2. It enriches each job with its Job Type and CRM Location.
3. It filters jobs by price, city, job type, completion state, verified
   completion-detail quality, and remaining public detail after privacy
   redaction.
4. It removes known customer names, exact addresses, email addresses, phone
   numbers, and links from generated copy.
5. It writes a concise local summary that includes the job type, city/state, and
   redacted completion detail without inventing outcomes.
6. It classifies the job as plumbing, HVAC, electrical, or a configured service.
7. WordPress creates the job as **Pending Review** and assigns service/location
   terms.
8. An editor reviews and publishes the post.
9. The Recent Local Jobs block shows the newest approved jobs on the matching
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
different. The block renders a local intro paragraph using the reviewed
service/city/job count, or you can provide custom intro copy in the block
settings.

By default, the plugin also appends Recent Local Jobs automatically to matching
nested location Pages such as `/plumbing/newark/`. It skips that automatic
output when the page already contains the block or shortcode, and the behavior
can be disabled in the Local Jobs Sync settings.

Classic Editor and page-builder sites can use the same renderer with a
shortcode:

```text
[st_recent_jobs service="plumbing" location="newark" count="3" intro="Recent plumbing work completed by our Newark team."]
```

Approved job posts are nested beneath that path:

```text
/plumbing/newark/job/job-123/
```

The block shows three jobs by default. The count is configurable globally and
per block. Pending jobs never appear.

The Recent Local Jobs and Job Details blocks emit conservative Schema.org
JSON-LD (`ItemList` and `Service`) for published jobs, using the same reviewed
summary, service, city, date, and permalink that visitors see.

## WordPress installation

1. Install the customer release ZIP, which has the hosted service URL embedded.
   Source/development installs can instead define `ST_SYNC_SERVICE_URL` or use
   the `st_sync_service_url` filter.
2. Activate **ServiceTitan Local Job Content**.
3. Use a non-Plain permalink structure.
4. Open **Local Jobs Sync** in the WordPress admin.
   You can also use the plugin list **Settings** link after activation.
5. Start a monthly or yearly subscription checkout, or paste an existing
   subscription license key.
6. Activate the site with the subscription license after checkout is complete.
7. Send ServiceTitan tenant/client credentials to the hosted service.
8. Configure content filters and service mappings.

Once activated, the Subscription panel includes a **Manage billing** button that
opens the hosted Stripe Billing Portal. Canceling there stops future sync claims
after Stripe webhooks update the hosted subscription state; existing WordPress
job posts remain untouched.
The settings page warns admins when WordPress is still using Plain permalinks,
because nested job URLs require a pretty permalink structure.

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
claims about completed work. The worker also checks the redacted public text
against the minimum summary length, so jobs that become mostly private-detail
placeholders are held back instead of queued for review.
Generated summaries are deterministic and reviewable. They add local context
such as `Drain Cleaning job completed for a local customer in Newark, NJ` before
the redacted completion detail, but they do not invent work that was not present
in the verified ServiceTitan completion field.

## Hosted service

The `service/` package is the subscription, activation, and credential boundary.
It stores license keys and activation tokens as hashes, encrypts ServiceTitan
credentials and WordPress delivery signing secrets, validates Stripe webhook
signatures, and returns only eligible sites to the worker.
It also owns each site's sync cursor: the first hosted claim uses the configured
initial backfill date, and later claims resume from the last successful worker
run with a small overlap for safety. Claims are leased for a short window so
two scheduled worker instances do not process the same customer site at the
same time; the worker releases that lease when it reports the run result.
Before every WordPress delivery, the worker asks the hosted service to recheck
the exact claim lease and current subscription. This prevents a cancellation
that happens mid-run from receiving later job posts, and customer-edited PHP
cannot bypass the hosted check.

Checkout creates a Stripe subscription session and returns a one-time license
key, but that key cannot activate a WordPress site until a signed Stripe webhook
updates the server-side subscription to `active` or `trialing`.
Delayed Stripe events are ordered by their signed event creation time, so an
older active snapshot cannot overwrite a newer cancellation.
Webhook deduplication and subscription updates are atomic, allowing Stripe to
retry safely if subscription persistence fails.
The plugin admin can start this checkout flow and shows the one-time license key
before redirecting to Stripe; it does not save that key locally.

Eligible means the server-side subscription is `active` or `trialing`. Canceled,
unpaid, paused, past-due, incomplete, and revoked activations do not appear in
worker sync claims. Existing WordPress job posts are not gated by entitlement and
remain on the customer's site.
The plugin settings page mirrors that boundary by warning when future imports
are paused while existing Local Job posts stay available.
The plugin admin also reads hosted sync health from the service, including the
last successful run, last attempt, run status, totals, and latest error.
It also displays whether ServiceTitan credentials have been connected in the
hosted service, without ever storing the ServiceTitan client secret in
WordPress.

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
Successful reports are monotonic, so a delayed worker cannot move a site's
cursor backward.

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

The Local Jobs admin list includes completed date, service/location, and source
update columns. Editors can sort by completed date and filter the list to jobs
that need ServiceTitan source-update review.
The Local Jobs Sync settings page also includes an **Editorial queue** panel
with counts and direct links for pending jobs and source updates that need
review, plus a **Location page coverage** panel that shows whether imported
service/location pairs have matching nested Pages for automatic block output
and whether those pages are drafts or published.
When a matching page is missing, admins can create a draft service/location
page hierarchy from that panel; the created location page includes the Recent
Local Jobs block with the matching slugs already set.

New imports use the **Job Details** block as their default post body. The
generated summary is stored in the excerpt and job meta, so the block can render
consistent visitor-facing details and JSON-LD immediately after an editor
publishes the post.

Publishing makes the job eligible for location-page blocks and the normal
WordPress sitemap. Uninstalling removes credentials and plugin settings but
preserves job posts and editorial content.

If ServiceTitan later changes a job after it has entered review, the sync does
not overwrite the WordPress post. Instead, the Local Job edit screen shows a
**ServiceTitan source update** box where an editor can compare the new source
details and either apply the reviewed update or dismiss it.

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

GitHub Actions runs those checks plus the integration suite against a freshly
installed disposable WordPress and MySQL site on every push and pull request.

## Release packaging

Build the customer-installable WordPress plugin ZIP with its vendor-controlled
hosted endpoint embedded:

```bash
RELEASE_BUILD=1 \
ST_SYNC_SERVICE_URL=https://sync.example.com \
sh scripts/build-plugin-zip.sh
```

Release builds fail if the URL is missing or does not use HTTPS. Running the
script without `RELEASE_BUILD=1` still produces an unconfigured development ZIP.

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
