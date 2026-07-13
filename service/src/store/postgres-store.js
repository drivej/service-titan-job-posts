'use strict';

const { decryptText, encryptText, licenseHash, randomSecret, sha256Hex } = require('../crypto');
const { buildEntitlement } = require('../entitlements');
const { serviceError } = require('../errors');
const { SYNC_CLAIM_LEASE_MS, syncWindowForSite } = require('./sync-window');

const LATEST_MIGRATION = '005_stripe_reconciliation_ordering.sql';

function row(result) {
  return result.rows && result.rows.length > 0 ? result.rows[0] : null;
}

function rows(result) {
  return result.rows || [];
}

class PostgresStore {
  constructor(queryable) {
    if (!queryable || typeof queryable.query !== 'function') {
      throw new Error('PostgresStore requires a pg Pool, Client, or compatible queryable');
    }
    this.db = queryable;
  }

  async withTransaction(callback) {
    if (typeof this.db.connect !== 'function') {
      return callback(this.db);
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async activateSite(input, context) {
    return this.withTransaction(async (client) => {
      const license = row(await client.query(
        `SELECT l.*, a.id AS account_id
           FROM licenses l
           INNER JOIN accounts a ON a.id = l.account_id
          WHERE l.key_hash = $1 AND l.active = true
          FOR UPDATE OF l`,
        [input.license_key_hash]
      ));
      if (!license) {
        throw serviceError(404, 'invalid_license', 'License key was not found.');
      }

      const subscription = row(await client.query(
        'SELECT * FROM subscriptions WHERE account_id = $1',
        [license.account_id]
      ));
      const entitlement = buildEntitlement(subscription, context.priceMap, context.now);
      if (!entitlement.eligible) {
        throw serviceError(402, 'subscription_required', 'An active or trialing subscription is required.');
      }

      let site = row(await client.query(
        `SELECT *
           FROM sites
          WHERE license_id = $1
            AND revoked_at IS NULL
            AND (installation_id = $2 OR site_url = $3)
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE`,
        [license.id, input.installation_id, input.site_url]
      ));

      if (!site) {
        const activeCount = row(await client.query(
          'SELECT count(*)::int AS count FROM sites WHERE license_id = $1 AND revoked_at IS NULL',
          [license.id]
        ));
        if ((activeCount ? activeCount.count : 0) >= (license.site_limit || context.defaultSiteLimit || 1)) {
          throw serviceError(409, 'site_limit_reached', 'This license has reached its site activation limit.');
        }
      }

      const activationToken = randomSecret('act');
      const signingSecret = randomSecret('sig');
      const signingEnvelope = encryptText(signingSecret, context.encryptionKey);
      const policy = Object.keys(input.policy || {}).length > 0
        ? input.policy
        : (site && site.policy ? site.policy : {});

      if (site) {
        site = row(await client.query(
          `UPDATE sites
              SET site_url = $2,
                  installation_id = $3,
                  delivery_url = $4,
                  plugin_version = $5,
                  activation_token_hash = $6,
                  signing_secret_encrypted = $7::jsonb,
                  policy = $8::jsonb,
                  updated_at = $9,
                  revoked_at = NULL
            WHERE id = $1
            RETURNING *`,
          [
            site.id,
            input.site_url,
            input.installation_id,
            input.delivery_url,
            input.plugin_version || '',
            sha256Hex(activationToken),
            JSON.stringify(signingEnvelope),
            JSON.stringify(policy),
            context.now
          ]
        ));
      } else {
        site = row(await client.query(
          `INSERT INTO sites (
             id, account_id, license_id, site_url, installation_id, delivery_url,
             plugin_version, activation_token_hash, signing_secret_encrypted,
             policy, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$11)
           RETURNING *`,
          [
            randomSecret('site', 16),
            license.account_id,
            license.id,
            input.site_url,
            input.installation_id,
            input.delivery_url,
            input.plugin_version || '',
            sha256Hex(activationToken),
            JSON.stringify(signingEnvelope),
            JSON.stringify(policy),
            context.now
          ]
        ));
      }

      return {
        site,
        activation_token: activationToken,
        signing_secret: signingSecret,
        entitlement
      };
    });
  }

  async healthCheck() {
    await this.db.query('SELECT 1');
    const migration = row(await this.db.query(
      'SELECT filename FROM service_migrations WHERE filename = $1 LIMIT 1',
      [LATEST_MIGRATION]
    ));

    return {
      ok: Boolean(migration),
      store: 'postgres',
      migrations: migration ? 'applied' : 'missing'
    };
  }

  async createBillingAccount(input, context) {
    return this.withTransaction(async (client) => {
      const email = String(input.email || '').toLowerCase();
      const account = row(await client.query(
        `INSERT INTO accounts (id, email, created_at, updated_at)
         VALUES ($1, $2, $3, $3)
         RETURNING *`,
        [randomSecret('acct', 16), email, context.now]
      ));

      const licenseKey = randomSecret('lic', 24).toUpperCase();
      const license = row(await client.query(
        `INSERT INTO licenses (
           id, account_id, key_hash, key_last4, active, site_limit, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,true,$5,$6,$6)
         RETURNING *`,
        [
          randomSecret('licrec', 16),
          account.id,
          licenseHash(licenseKey),
          licenseKey.slice(-4),
          Math.max(1, Number.parseInt(input.site_limit || context.defaultSiteLimit || 1, 10) || 1),
          context.now
        ]
      ));

      return {
        account,
        license,
        license_key: licenseKey
      };
    });
  }

  async attachStripeCustomer(accountId, stripeCustomerId, context) {
    const account = row(await this.db.query(
      `UPDATE accounts
          SET stripe_customer_id = $2,
              updated_at = $3
        WHERE id = $1
        RETURNING *`,
      [accountId, stripeCustomerId, context.now]
    ));
    if (!account) {
      throw serviceError(404, 'billing_account_not_found', 'Billing account was not found.');
    }
    return account;
  }

  async billingAccountForLicenseHash(keyHash) {
    return row(await this.db.query(
      `SELECT a.*
         FROM licenses l
         INNER JOIN accounts a ON a.id = l.account_id
        WHERE l.key_hash = $1 AND l.active = true
        LIMIT 1`,
      [keyHash]
    ));
  }

  async billingAccountForSite(siteId) {
    return row(await this.db.query(
      `SELECT a.*
         FROM sites s
         INNER JOIN accounts a ON a.id = s.account_id
        WHERE s.id = $1 AND s.revoked_at IS NULL
        LIMIT 1`,
      [siteId]
    ));
  }

  async siteForToken(tokenHash, context) {
    const site = row(await this.db.query(
      'SELECT * FROM sites WHERE activation_token_hash = $1 AND revoked_at IS NULL',
      [tokenHash]
    ));
    if (!site) {
      throw serviceError(401, 'invalid_activation_token', 'Activation token is invalid or revoked.');
    }

    const subscription = row(await this.db.query(
      'SELECT * FROM subscriptions WHERE account_id = $1',
      [site.account_id]
    ));
    const connection = row(await this.db.query(
      'SELECT tenant_id, environment, updated_at FROM servicetitan_connections WHERE site_id = $1',
      [site.id]
    ));
    return {
      site,
      connection,
      entitlement: buildEntitlement(subscription, context.priceMap, context.now)
    };
  }

  async connectServiceTitan(siteId, connection, context) {
    const site = row(await this.db.query(
      'SELECT id FROM sites WHERE id = $1 AND revoked_at IS NULL',
      [siteId]
    ));
    if (!site) {
      throw serviceError(404, 'site_not_found', 'Site was not found.');
    }

    return row(await this.db.query(
      `INSERT INTO servicetitan_connections (
         site_id, tenant_id, environment, client_id_encrypted,
         client_secret_encrypted, created_at, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$6)
       ON CONFLICT (site_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         environment = EXCLUDED.environment,
         client_id_encrypted = EXCLUDED.client_id_encrypted,
         client_secret_encrypted = EXCLUDED.client_secret_encrypted,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        siteId,
        connection.tenant_id,
        connection.environment,
        JSON.stringify(encryptText(connection.client_id, context.encryptionKey)),
        JSON.stringify(encryptText(connection.client_secret, context.encryptionKey)),
        context.now
      ]
    ));
  }

  async updatePolicy(siteId, policy, context) {
    const site = row(await this.db.query(
      `UPDATE sites
          SET policy = $2::jsonb,
              updated_at = $3
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING policy`,
      [siteId, JSON.stringify(policy), context.now]
    ));
    if (!site) {
      throw serviceError(404, 'site_not_found', 'Site was not found.');
    }
    return site.policy || {};
  }

  async revokeSite(siteId, context) {
    const result = await this.db.query(
      `UPDATE sites
          SET revoked_at = $2,
              updated_at = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [siteId, context.now]
    );
    return result.rowCount > 0;
  }

  async listEligibleSyncClaims(context) {
    const now = context.now || new Date();
    const nowDate = now instanceof Date ? now : new Date(now);
    const runStartedAt = context.runStartedAt instanceof Date
      ? context.runStartedAt
      : new Date(context.runStartedAt || nowDate);
    const claimLimit = 1;

    return this.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT
           s.*,
           sub.status,
           sub.price_id,
           sub.current_period_end,
           c.tenant_id,
           c.environment,
           c.client_id_encrypted,
           c.client_secret_encrypted
         FROM sites s
         INNER JOIN servicetitan_connections c ON c.site_id = s.id
         INNER JOIN subscriptions sub ON sub.account_id = s.account_id
         WHERE s.revoked_at IS NULL
           AND (s.sync_claimed_until IS NULL OR s.sync_claimed_until <= $1)
           AND sub.status IN ('active', 'trialing')
           AND sub.current_period_end > $1
           AND (s.last_sync_attempt_at IS NULL OR s.last_sync_attempt_at < $2)
         ORDER BY s.last_sync_attempt_at ASC NULLS FIRST, s.id ASC
         LIMIT $3
         FOR UPDATE OF s SKIP LOCKED`,
        [nowDate, runStartedAt, claimLimit]
      );

      const claims = [];
      for (const record of rows(result)) {
        const entitlement = buildEntitlement({
          status: record.status,
          price_id: record.price_id,
          current_period_end: record.current_period_end
        }, context.priceMap, nowDate);
        if (!entitlement.eligible) continue;
        const window = syncWindowForSite(record, { ...context, now: nowDate });
        const claimId = randomSecret('claim', 16);
        const claimedUntil = new Date(nowDate.getTime() + SYNC_CLAIM_LEASE_MS);

        await client.query(
          `UPDATE sites
              SET sync_claim_id = $2,
                  sync_claimed_until = $3,
                  updated_at = $4
            WHERE id = $1`,
          [record.id, claimId, claimedUntil, nowDate]
        );

        claims.push({
          site_id: record.id,
          claim_id: claimId,
          sync_claimed_until: claimedUntil.toISOString(),
          site_url: record.site_url,
          delivery_url: record.delivery_url,
          modified_on_or_after: window.modified_on_or_after,
          modified_before: window.modified_before,
          entitlement,
          policy: record.policy || {},
          signing_secret: decryptText(record.signing_secret_encrypted, context.encryptionKey),
          service_titan: {
            tenant_id: record.tenant_id,
            environment: record.environment,
            client_id: decryptText(record.client_id_encrypted, context.encryptionKey),
            client_secret: decryptText(record.client_secret_encrypted, context.encryptionKey)
          }
        });
      }

      return claims;
    });
  }

  async authorizeSyncDelivery(input, context) {
    const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
    const record = row(await this.db.query(
      `SELECT s.sync_claim_id, s.sync_claimed_until, s.revoked_at,
              sub.status, sub.price_id, sub.current_period_end
         FROM sites s
         LEFT JOIN subscriptions sub ON sub.account_id = s.account_id
        WHERE s.id = $1`,
      [input.site_id]
    ));

    if (!record || record.revoked_at) {
      return { authorized: false, reason: 'site_unavailable' };
    }
    const claimedUntil = new Date(record.sync_claimed_until || 0);
    if (
      record.sync_claim_id !== input.claim_id ||
      !Number.isFinite(claimedUntil.getTime()) ||
      claimedUntil <= now
    ) {
      return { authorized: false, reason: 'invalid_or_expired_claim' };
    }

    const entitlement = buildEntitlement(record, context.priceMap, now);
    return {
      authorized: entitlement.eligible,
      reason: entitlement.eligible ? 'authorized' : 'subscription_ineligible'
    };
  }

  async recordSyncRun(input, context) {
    const now = context.now || new Date();
    const stats = input.stats && typeof input.stats === 'object' ? input.stats : {};
    const site = row(await this.db.query(
      `UPDATE sites
          SET last_sync_attempt_at = $2,
              last_sync_status = $3,
              last_sync_error = $4,
              last_sync_stats = $5::jsonb,
              last_successful_sync_at = CASE
                WHEN $3 = 'success'
                 AND (last_successful_sync_at IS NULL OR $6::timestamptz > last_successful_sync_at)
                THEN $6::timestamptz
                ELSE last_successful_sync_at
              END,
              sync_claim_id = CASE
                WHEN $7 = '' OR sync_claim_id IS NULL OR sync_claim_id = $7 THEN NULL
                ELSE sync_claim_id
              END,
              sync_claimed_until = CASE
                WHEN $7 = '' OR sync_claim_id IS NULL OR sync_claim_id = $7 THEN NULL
                ELSE sync_claimed_until
              END,
              updated_at = $2
        WHERE id = $1
          AND revoked_at IS NULL
          AND sync_claim_id = $7
        RETURNING id, last_successful_sync_at, last_sync_attempt_at,
                  last_sync_status, last_sync_error, last_sync_stats`,
      [
        input.site_id,
        now,
        input.status,
        input.status === 'failed' ? String(input.error || '').slice(0, 2000) : '',
        JSON.stringify(stats),
        input.status === 'success' ? input.processed_until : null,
        input.claim_id || ''
      ]
    ));
    if (!site) {
      const existing = row(await this.db.query(
        'SELECT id, revoked_at FROM sites WHERE id = $1',
        [input.site_id]
      ));
      if (!existing || existing.revoked_at) {
        throw serviceError(404, 'site_not_found', 'Site was not found.');
      }
      throw serviceError(409, 'stale_sync_claim', 'Sync run no longer owns the active site claim.');
    }

    return {
      site_id: site.id,
      last_successful_sync_at: site.last_successful_sync_at,
      last_sync_attempt_at: site.last_sync_attempt_at,
      last_sync_status: site.last_sync_status,
      last_sync_error: site.last_sync_error,
      last_sync_stats: site.last_sync_stats || {}
    };
  }

  async processStripeWebhook(event, subscription, context) {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO stripe_webhook_events (id, type)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [event.id, event.type]
      );
      if (result.rowCount === 0) return false;

      if (subscription) {
        const applied = await this.applyStripeSubscription(subscription, context, client);
        if (!applied) {
          throw serviceError(503, 'stripe_subscription_not_mapped', 'Stripe subscription could not be mapped to an account.');
        }
      }
      return true;
    });
  }

  async hasProcessedStripeWebhook(eventId) {
    const existing = row(await this.db.query(
      'SELECT id FROM stripe_webhook_events WHERE id = $1 LIMIT 1',
      [eventId]
    ));
    return Boolean(existing);
  }

  async nextStripeReconciliationSequence() {
    const result = row(await this.db.query(
      "SELECT nextval('stripe_reconciliation_sequence')::bigint AS sequence"
    ));
    return Number(result.sequence);
  }

  async applyStripeSubscription(subscription, context, queryable = this.db) {
    if (!subscription) return null;

    let accountId = subscription.account_id;
    if (!accountId && subscription.stripe_customer_id) {
      const account = row(await queryable.query(
        'SELECT id FROM accounts WHERE stripe_customer_id = $1',
        [subscription.stripe_customer_id]
      ));
      accountId = account && account.id;
    }
    if (!accountId) return null;

    const applied = row(await queryable.query(
      `INSERT INTO subscriptions (
         account_id, stripe_subscription_id, stripe_customer_id, status,
         price_id, current_period_end, cancel_at_period_end, stripe_event_created,
         stripe_reconciliation_sequence, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (account_id) DO UPDATE SET
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         status = EXCLUDED.status,
         price_id = EXCLUDED.price_id,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         stripe_event_created = EXCLUDED.stripe_event_created,
         stripe_reconciliation_sequence = EXCLUDED.stripe_reconciliation_sequence,
         updated_at = now()
       WHERE (
              EXCLUDED.stripe_reconciliation_sequence IS NOT NULL
              AND (
                subscriptions.stripe_reconciliation_sequence IS NULL
                OR EXCLUDED.stripe_reconciliation_sequence >= subscriptions.stripe_reconciliation_sequence
              )
             )
          OR (
              EXCLUDED.stripe_reconciliation_sequence IS NULL
              AND subscriptions.stripe_reconciliation_sequence IS NULL
              AND (
                subscriptions.stripe_event_created IS NULL
                OR EXCLUDED.stripe_event_created IS NULL
                OR EXCLUDED.stripe_event_created > subscriptions.stripe_event_created
                OR (
                  EXCLUDED.stripe_event_created = subscriptions.stripe_event_created
                  AND subscriptions.status IN ('active', 'trialing')
                  AND EXCLUDED.status NOT IN ('active', 'trialing')
                )
              )
             )
       RETURNING *`,
      [
        accountId,
        subscription.stripe_subscription_id,
        subscription.stripe_customer_id || '',
        subscription.status || 'unknown',
        subscription.price_id || '',
        subscription.current_period_end || null,
        subscription.cancel_at_period_end === true,
        subscription.stripe_event_created != null && Number.isFinite(Number(subscription.stripe_event_created))
          ? Number(subscription.stripe_event_created)
          : null,
        subscription.stripe_reconciliation_sequence != null &&
          Number.isFinite(Number(subscription.stripe_reconciliation_sequence))
          ? Number(subscription.stripe_reconciliation_sequence)
          : null
      ]
    ));
    if (applied) return applied;

    return row(await queryable.query(
      'SELECT * FROM subscriptions WHERE account_id = $1',
      [accountId]
    ));
  }
}

module.exports = {
  PostgresStore
};
