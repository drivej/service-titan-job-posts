'use strict';

const { decryptText, encryptText, licenseHash, randomSecret, sha256Hex } = require('../crypto');
const { buildEntitlement } = require('../entitlements');
const { serviceError } = require('../errors');
const { SYNC_CLAIM_LEASE_MS, syncWindowForSite } = require('./sync-window');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function isSyncClaimLeased(site, now) {
  const claimedUntil = Date.parse(String(site.sync_claimed_until || ''));
  return Number.isFinite(claimedUntil) && claimedUntil > now.getTime();
}

function isNewerCursor(currentCursor, processedUntil) {
  const current = Date.parse(String(currentCursor || ''));
  const next = processedUntil instanceof Date ? processedUntil.getTime() : Date.parse(String(processedUntil || ''));
  return Number.isFinite(next) && (!Number.isFinite(current) || next > current);
}

class MemoryStore {
  constructor(seed = {}) {
    this.accounts = new Map();
    this.licenses = new Map();
    this.subscriptions = new Map();
    this.sites = new Map();
    this.connections = new Map();
    this.webhookEvents = new Set();
    this.stripeReconciliationSequence = 0;

    for (const account of seed.accounts || []) {
      this.accounts.set(account.id, { ...account });
    }
    for (const license of seed.licenses || []) {
      this.licenses.set(license.id, {
        active: true,
        site_limit: 1,
        ...license
      });
    }
    for (const subscription of seed.subscriptions || []) {
      this.subscriptions.set(subscription.account_id, { ...subscription });
      const sequence = Number(subscription.stripe_reconciliation_sequence);
      if (Number.isFinite(sequence)) {
        this.stripeReconciliationSequence = Math.max(this.stripeReconciliationSequence, sequence);
      }
    }
    for (const site of seed.sites || []) {
      this.sites.set(site.id, { ...site });
    }
    for (const connection of seed.connections || []) {
      this.connections.set(connection.site_id, { ...connection });
    }
  }

  async activateSite(input, context) {
    const now = context.now || new Date();
    const license = [...this.licenses.values()].find((candidate) =>
      candidate.key_hash === input.license_key_hash && candidate.active !== false
    );
    if (!license) {
      throw serviceError(404, 'invalid_license', 'License key was not found.');
    }

    const account = this.accounts.get(license.account_id);
    if (!account) {
      throw serviceError(409, 'license_without_account', 'License is not attached to an account.');
    }

    const subscription = this.subscriptions.get(account.id);
    const entitlement = buildEntitlement(subscription, context.priceMap, now);
    if (!entitlement.eligible) {
      throw serviceError(402, 'subscription_required', 'An active or trialing subscription is required.');
    }

    const activeSites = [...this.sites.values()].filter((site) =>
      site.license_id === license.id && !site.revoked_at
    );
    let site = activeSites.find((candidate) =>
      candidate.installation_id === input.installation_id || candidate.site_url === input.site_url
    );

    if (!site && activeSites.length >= (license.site_limit || context.defaultSiteLimit || 1)) {
      throw serviceError(409, 'site_limit_reached', 'This license has reached its site activation limit.');
    }

    const activationToken = randomSecret('act');
    const signingSecret = randomSecret('sig');
    const siteId = site ? site.id : randomSecret('site', 16);
    const record = {
      id: siteId,
      account_id: account.id,
      license_id: license.id,
      site_url: input.site_url,
      installation_id: input.installation_id,
      delivery_url: input.delivery_url,
      plugin_version: input.plugin_version || '',
      activation_token_hash: sha256Hex(activationToken),
      signing_secret_encrypted: encryptText(signingSecret, context.encryptionKey),
      policy: Object.keys(input.policy || {}).length > 0
        ? { ...input.policy }
        : (site && site.policy ? site.policy : {}),
      last_successful_sync_at: site && site.last_successful_sync_at ? site.last_successful_sync_at : null,
      last_sync_attempt_at: site && site.last_sync_attempt_at ? site.last_sync_attempt_at : null,
      last_sync_status: site && site.last_sync_status ? site.last_sync_status : null,
      last_sync_error: site && site.last_sync_error ? site.last_sync_error : '',
      last_sync_stats: site && site.last_sync_stats ? clone(site.last_sync_stats) : {},
      sync_claim_id: site && site.sync_claim_id ? site.sync_claim_id : null,
      sync_claimed_until: site && site.sync_claimed_until ? site.sync_claimed_until : null,
      created_at: site && site.created_at ? site.created_at : nowIso(now),
      updated_at: nowIso(now),
      revoked_at: null
    };

    this.sites.set(siteId, record);

    return {
      site: clone(record),
      activation_token: activationToken,
      signing_secret: signingSecret,
      entitlement
    };
  }

  async healthCheck() {
    return {
      ok: true,
      store: 'memory'
    };
  }

  async createBillingAccount(input, context) {
    const now = context.now || new Date();
    const email = String(input.email || '').toLowerCase();
    const account = {
      id: randomSecret('acct', 16),
      email,
      stripe_customer_id: '',
      created_at: nowIso(now),
      updated_at: nowIso(now)
    };
    this.accounts.set(account.id, account);

    const licenseKey = randomSecret('lic', 24).toUpperCase();
    const license = {
      id: randomSecret('licrec', 16),
      account_id: account.id,
      key_hash: licenseHash(licenseKey),
      key_last4: licenseKey.slice(-4),
      active: true,
      site_limit: Math.max(1, Number.parseInt(input.site_limit || context.defaultSiteLimit || 1, 10) || 1),
      created_at: nowIso(now),
      updated_at: nowIso(now)
    };
    this.licenses.set(license.id, license);

    return {
      account: clone(account),
      license: clone(license),
      license_key: licenseKey
    };
  }

  async attachStripeCustomer(accountId, stripeCustomerId, context) {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw serviceError(404, 'billing_account_not_found', 'Billing account was not found.');
    }
    account.stripe_customer_id = stripeCustomerId;
    account.updated_at = nowIso(context.now || new Date());
    return clone(account);
  }

  async billingAccountForLicenseHash(keyHash) {
    const license = [...this.licenses.values()].find((candidate) =>
      candidate.key_hash === keyHash && candidate.active !== false
    );
    if (!license) return null;

    const account = this.accounts.get(license.account_id);
    return account ? clone(account) : null;
  }

  async billingAccountForSite(siteId) {
    const site = this.sites.get(siteId);
    if (!site || site.revoked_at) return null;

    const account = this.accounts.get(site.account_id);
    return account ? clone(account) : null;
  }

  async siteForToken(tokenHash, context) {
    const site = [...this.sites.values()].find((candidate) =>
      candidate.activation_token_hash === tokenHash && !candidate.revoked_at
    );
    if (!site) {
      throw serviceError(401, 'invalid_activation_token', 'Activation token is invalid or revoked.');
    }

    const subscription = this.subscriptions.get(site.account_id);
    const connection = this.connections.get(site.id);
    return {
      site: clone(site),
      connection: connection ? clone({
        tenant_id: connection.tenant_id,
        environment: connection.environment,
        updated_at: connection.updated_at || ''
      }) : null,
      entitlement: buildEntitlement(subscription, context.priceMap, context.now || new Date())
    };
  }

  async connectServiceTitan(siteId, connection, context) {
    if (!this.sites.has(siteId)) {
      throw serviceError(404, 'site_not_found', 'Site was not found.');
    }

    const record = {
      site_id: siteId,
      tenant_id: connection.tenant_id,
      environment: connection.environment,
      client_id_encrypted: encryptText(connection.client_id, context.encryptionKey),
      client_secret_encrypted: encryptText(connection.client_secret, context.encryptionKey),
      updated_at: nowIso(context.now || new Date())
    };
    this.connections.set(siteId, record);
    return clone(record);
  }

  async updatePolicy(siteId, policy, context) {
    const site = this.sites.get(siteId);
    if (!site || site.revoked_at) {
      throw serviceError(404, 'site_not_found', 'Site was not found.');
    }

    site.policy = { ...policy };
    site.updated_at = nowIso(context.now || new Date());
    return clone(site.policy);
  }

  async revokeSite(siteId, context) {
    const site = this.sites.get(siteId);
    if (!site || site.revoked_at) return false;

    site.revoked_at = nowIso(context.now || new Date());
    site.updated_at = site.revoked_at;
    return true;
  }

  async listEligibleSyncClaims(context) {
    const claims = [];
    const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
    const runStartedAt = context.runStartedAt instanceof Date
      ? context.runStartedAt
      : new Date(context.runStartedAt || now);
    const limit = 1;
    const sites = [...this.sites.values()].sort((left, right) => {
      const leftAttempt = left.last_sync_attempt_at ? new Date(left.last_sync_attempt_at).getTime() : -Infinity;
      const rightAttempt = right.last_sync_attempt_at ? new Date(right.last_sync_attempt_at).getTime() : -Infinity;
      return leftAttempt - rightAttempt || String(left.id).localeCompare(String(right.id));
    });

    for (const site of sites) {
      if (site.revoked_at) continue;
      if (isSyncClaimLeased(site, now)) continue;
      const lastAttempt = new Date(site.last_sync_attempt_at || 0);
      if (Number.isFinite(lastAttempt.getTime()) && lastAttempt >= runStartedAt) continue;

      const subscription = this.subscriptions.get(site.account_id);
      const entitlement = buildEntitlement(subscription, context.priceMap, now);
      if (!entitlement.eligible) continue;

      const connection = this.connections.get(site.id);
      if (!connection) continue;
      const window = syncWindowForSite(site, context);
      const claimId = randomSecret('claim', 16);
      const claimedUntil = new Date(now.getTime() + SYNC_CLAIM_LEASE_MS).toISOString();

      site.sync_claim_id = claimId;
      site.sync_claimed_until = claimedUntil;
      site.updated_at = nowIso(now);

      claims.push({
        site_id: site.id,
        claim_id: claimId,
        sync_claimed_until: claimedUntil,
        site_url: site.site_url,
        delivery_url: site.delivery_url,
        modified_on_or_after: window.modified_on_or_after,
        modified_before: window.modified_before,
        entitlement,
        policy: clone(site.policy || {}),
        signing_secret: decryptText(site.signing_secret_encrypted, context.encryptionKey),
        service_titan: {
          tenant_id: connection.tenant_id,
          environment: connection.environment,
          client_id: decryptText(connection.client_id_encrypted, context.encryptionKey),
          client_secret: decryptText(connection.client_secret_encrypted, context.encryptionKey)
        }
      });
      if (claims.length >= limit) break;
    }
    return claims;
  }

  async authorizeSyncDelivery(input, context) {
    const site = this.sites.get(input.site_id);
    if (!site || site.revoked_at) {
      return { authorized: false, reason: 'site_unavailable' };
    }

    const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
    if (site.sync_claim_id !== input.claim_id || !isSyncClaimLeased(site, now)) {
      return { authorized: false, reason: 'invalid_or_expired_claim' };
    }

    const subscription = this.subscriptions.get(site.account_id);
    const entitlement = buildEntitlement(subscription, context.priceMap, now);
    return {
      authorized: entitlement.eligible,
      reason: entitlement.eligible ? 'authorized' : 'subscription_ineligible'
    };
  }

  async recordSyncRun(input, context) {
    const site = this.sites.get(input.site_id);
    if (!site || site.revoked_at) {
      throw serviceError(404, 'site_not_found', 'Site was not found.');
    }
    if (!site.sync_claim_id || site.sync_claim_id !== input.claim_id) {
      throw serviceError(409, 'stale_sync_claim', 'Sync run no longer owns the active site claim.');
    }

    const now = context.now || new Date();
    site.last_sync_attempt_at = nowIso(now);
    site.last_sync_status = input.status;
    site.last_sync_error = input.status === 'failed' ? String(input.error || '').slice(0, 2000) : '';
    site.last_sync_stats = clone(input.stats || {});
    if (input.status === 'success' && isNewerCursor(site.last_successful_sync_at, input.processed_until)) {
      site.last_successful_sync_at = nowIso(input.processed_until);
    }
    site.sync_claim_id = null;
    site.sync_claimed_until = null;
    site.updated_at = nowIso(now);

    return clone({
      site_id: site.id,
      last_successful_sync_at: site.last_successful_sync_at || null,
      last_sync_attempt_at: site.last_sync_attempt_at,
      last_sync_status: site.last_sync_status,
      last_sync_error: site.last_sync_error,
      last_sync_stats: site.last_sync_stats
    });
  }

  async processStripeWebhook(event, subscription, context) {
    if (this.webhookEvents.has(event.id)) return false;
    if (subscription) {
      const applied = await this.applyStripeSubscription(subscription, context);
      if (!applied) {
        throw serviceError(503, 'stripe_subscription_not_mapped', 'Stripe subscription could not be mapped to an account.');
      }
    }
    this.webhookEvents.add(event.id);
    return true;
  }

  async hasProcessedStripeWebhook(eventId) {
    return this.webhookEvents.has(eventId);
  }

  async nextStripeReconciliationSequence() {
    this.stripeReconciliationSequence += 1;
    return this.stripeReconciliationSequence;
  }

  async applyStripeSubscription(subscription) {
    if (!subscription) return null;

    let accountId = subscription.account_id;
    if (!accountId && subscription.stripe_customer_id) {
      const account = [...this.accounts.values()].find((candidate) =>
        candidate.stripe_customer_id === subscription.stripe_customer_id
      );
      accountId = account && account.id;
    }
    if (!accountId || !this.accounts.has(accountId)) return null;

    const current = this.subscriptions.get(accountId);
    const incomingEventCreated = subscription.stripe_event_created == null
      ? Number.NaN
      : Number(subscription.stripe_event_created);
    const currentEventCreated = !current || current.stripe_event_created == null
      ? Number.NaN
      : Number(current.stripe_event_created);
    const incomingSequence = subscription.stripe_reconciliation_sequence == null
      ? Number.NaN
      : Number(subscription.stripe_reconciliation_sequence);
    const currentSequence = !current || current.stripe_reconciliation_sequence == null
      ? Number.NaN
      : Number(current.stripe_reconciliation_sequence);
    const incomingEligible = ['active', 'trialing'].includes(String(subscription.status || ''));
    const currentEligible = ['active', 'trialing'].includes(String(current && current.status || ''));
    if (
      Number.isFinite(incomingSequence) &&
      Number.isFinite(currentSequence) &&
      incomingSequence < currentSequence
    ) {
      return clone(current);
    }
    if (!Number.isFinite(incomingSequence) && Number.isFinite(currentSequence)) {
      return clone(current);
    }
    if (
      !Number.isFinite(incomingSequence) &&
      Number.isFinite(incomingEventCreated) &&
      Number.isFinite(currentEventCreated) &&
      (
        incomingEventCreated < currentEventCreated ||
        (
          incomingEventCreated === currentEventCreated &&
          (incomingEligible || !currentEligible)
        )
      )
    ) {
      return clone(current);
    }

    const record = {
      account_id: accountId,
      stripe_subscription_id: subscription.stripe_subscription_id,
      stripe_customer_id: subscription.stripe_customer_id || '',
      status: subscription.status || 'unknown',
      price_id: subscription.price_id || '',
      current_period_end: subscription.current_period_end || '',
      cancel_at_period_end: subscription.cancel_at_period_end === true,
      stripe_event_created: Number.isFinite(incomingEventCreated) ? incomingEventCreated : null,
      stripe_reconciliation_sequence: Number.isFinite(incomingSequence) ? incomingSequence : null,
      updated_at: new Date().toISOString()
    };
    this.subscriptions.set(accountId, record);
    return clone(record);
  }

  dump() {
    return clone({
      accounts: [...this.accounts.values()],
      licenses: [...this.licenses.values()],
      subscriptions: [...this.subscriptions.values()],
      sites: [...this.sites.values()],
      connections: [...this.connections.values()]
    });
  }
}

module.exports = {
  MemoryStore
};
