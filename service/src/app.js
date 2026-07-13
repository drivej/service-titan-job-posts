'use strict';

const { createConfig } = require('./config');
const { hmacSha256Hex, licenseHash, normalizeSiteOrigin, randomSecret, sha256Hex, timingSafeEqualString } = require('./crypto');
const { buildEntitlement } = require('./entitlements');
const { ServiceError, serviceError } = require('./errors');
const { StripeApiClient } = require('./stripe-client');
const { subscriptionFromStripeObject, verifyStripeSignature } = require('./stripe');

const JSON_LIMIT_BYTES = 1024 * 1024;
const SYNC_CLAIM_RUN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CHECKOUT_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const POLICY_KEYS = new Set([
  'min_price',
  'jobs_since',
  'min_summary_words',
  'completion_custom_field',
  'default_service_slug',
  'service_mappings',
  'allowed_cities',
  'excluded_job_types'
]);
const SYNC_RUN_STATUSES = new Set(['success', 'failed']);

function jsonResponse(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT_BYTES) {
        reject(serviceError(413, 'body_too_large', 'Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function parseJson(rawBody) {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw serviceError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

function bearerToken(request) {
  const authorization = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : '';
}

function sanitizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320) {
    throw serviceError(400, 'invalid_email', 'A valid customer email is required.');
  }
  return email;
}

function sanitizeCheckoutSite(input) {
  const installationId = String(input.installation_id || '').trim();
  if (!installationId || installationId.length > 200) {
    throw serviceError(400, 'invalid_checkout_site', 'installation_id is required.');
  }
  let siteUrl;
  try {
    siteUrl = normalizeSiteOrigin(input.site_url);
  } catch (error) {
    throw serviceError(400, 'invalid_checkout_site', 'site_url must be a valid http or https URL.');
  }
  const parsed = new URL(siteUrl);
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHost) {
    throw serviceError(400, 'invalid_checkout_site', 'site_url must use HTTPS outside local development.');
  }
  return { installation_id: installationId, site_url: siteUrl };
}

function sanitizeCheckoutRecovery(input) {
  const checkoutSessionId = String(input.checkout_session_id || '').trim();
  const recoveryToken = String(input.recovery_token || '').trim();
  if (!/^cs_[A-Za-z0-9_]+$/.test(checkoutSessionId) || !/^recover_[A-Za-z0-9_-]{32,}$/.test(recoveryToken)) {
    throw serviceError(404, 'checkout_recovery_unavailable', 'Checkout recovery is unavailable.');
  }
  return {
    ...sanitizeCheckoutSite(input),
    checkout_session_id: checkoutSessionId,
    recovery_token: recoveryToken
  };
}

function recoveryLicenseKey(encryptionKey, checkoutSessionId, recoveryToken) {
  const digest = hmacSha256Hex(
    encryptionKey,
    `service-titan-job-post:checkout-license:v1\0${checkoutSessionId}\0${recoveryToken}`
  );
  return `LIC_${digest.slice(0, 48).toUpperCase()}`;
}

function configuredUrl(value, fallback, code) {
  const url = String(value || fallback || '').trim();
  if (!url) {
    throw serviceError(500, code, 'A required hosted billing URL is not configured.');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw serviceError(500, code, 'A required hosted billing URL is invalid.');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw serviceError(500, code, 'Hosted billing URLs must use HTTPS outside local development.');
  }
  return parsed.href;
}

function planPriceId(plan, config) {
  const normalized = String(plan || '').trim().toLowerCase();
  if (!['monthly', 'yearly'].includes(normalized)) {
    throw serviceError(400, 'invalid_plan', 'Plan must be monthly or yearly.');
  }

  const priceId = config.stripePriceIds[normalized];
  if (!priceId) {
    throw serviceError(500, 'stripe_price_not_configured', `Stripe ${normalized} price ID is not configured.`);
  }

  return { plan: normalized, priceId };
}

async function requireSite(request, store, context) {
  const token = bearerToken(request);
  if (!token) {
    throw serviceError(401, 'missing_activation_token', 'Bearer activation token is required.');
  }
  return store.siteForToken(sha256Hex(token), context);
}

function requireWorker(request, config) {
  const expected = config.workerApiKey;
  if (!expected) {
    throw serviceError(500, 'worker_auth_not_configured', 'Worker API key is not configured.');
  }
  const token = bearerToken(request);
  if (!timingSafeEqualString(token, expected)) {
    throw serviceError(401, 'invalid_worker_token', 'Worker token is invalid.');
  }
}

function sanitizePolicy(input) {
  const policy = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (POLICY_KEYS.has(key)) {
      policy[key] = typeof value === 'string' ? value.trim() : String(value);
    }
  }
  return policy;
}

function normalizeDeliveryUrl(value, siteOrigin, config = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch (error) {
    throw serviceError(400, 'invalid_delivery_url', 'delivery_url must be a valid URL.');
  }

  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';

  const host = parsed.hostname;
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const insecureLocalAllowed = localHost && config.allowInsecureLocalDelivery === true;
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && insecureLocalAllowed)) {
    throw serviceError(400, 'invalid_delivery_url', 'delivery_url must use HTTPS outside local development.');
  }

  if (parsed.origin.toLowerCase() !== siteOrigin) {
    throw serviceError(400, 'invalid_delivery_url', 'delivery_url must use the same origin as site_url.');
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname !== '/wp-json/st-sync/v1/jobs') {
    throw serviceError(400, 'invalid_delivery_url', 'delivery_url must point to /wp-json/st-sync/v1/jobs.');
  }

  return parsed.href.replace(/\/+$/, '');
}

function sanitizeConnection(input) {
  const tenantId = String(input.tenant_id || '').replace(/\D+/g, '');
  const clientId = String(input.client_id || '').trim();
  const clientSecret = String(input.client_secret || '').trim();
  const environment = input.environment === 'integration' ? 'integration' : 'production';
  if (!tenantId || !clientId || !clientSecret) {
    throw serviceError(400, 'invalid_servicetitan_connection', 'tenant_id, client_id, and client_secret are required.');
  }
  return {
    tenant_id: tenantId,
    client_id: clientId,
    client_secret: clientSecret,
    environment
  };
}

function sanitizeSyncStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function isoStringOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function syncStatusForSite(site) {
  return {
    last_successful_sync_at: isoStringOrNull(site.last_successful_sync_at),
    last_sync_attempt_at: isoStringOrNull(site.last_sync_attempt_at),
    last_sync_status: String(site.last_sync_status || ''),
    last_sync_error: String(site.last_sync_error || ''),
    last_sync_stats: sanitizeSyncStats(site.last_sync_stats)
  };
}

function connectionStatus(connection) {
  if (!connection) {
    return {
      connected: false,
      tenant_id: '',
      environment: '',
      updated_at: null
    };
  }

  return {
    connected: true,
    tenant_id: String(connection.tenant_id || ''),
    environment: String(connection.environment || ''),
    updated_at: isoStringOrNull(connection.updated_at)
  };
}

function sanitizeSyncRun(input) {
  const siteId = String(input.site_id || '').trim();
  const claimId = String(input.claim_id || '').trim().slice(0, 120);
  const status = String(input.status || '').trim().toLowerCase();
  if (!siteId || !claimId || !SYNC_RUN_STATUSES.has(status)) {
    throw serviceError(400, 'invalid_sync_run', 'site_id, claim_id, and status of success or failed are required.');
  }

  let processedUntil = null;
  if (input.processed_until) {
    const parsed = new Date(String(input.processed_until));
    if (!Number.isFinite(parsed.getTime())) {
      throw serviceError(400, 'invalid_sync_run', 'processed_until must be a valid date.');
    }
    processedUntil = parsed;
  }
  if (status === 'success' && !processedUntil) {
    throw serviceError(400, 'invalid_sync_run', 'processed_until is required for successful sync runs.');
  }

  return {
    site_id: siteId,
    claim_id: claimId,
    status,
    processed_until: processedUntil,
    stats: sanitizeSyncStats(input.stats),
    error: String(input.error || '').trim().slice(0, 2000)
  };
}

function sanitizeSyncAuthorization(input) {
  const siteId = String(input.site_id || '').trim();
  const claimId = String(input.claim_id || '').trim().slice(0, 120);
  if (!siteId || !claimId) {
    throw serviceError(400, 'invalid_sync_authorization', 'site_id and claim_id are required.');
  }
  return { site_id: siteId, claim_id: claimId };
}

function sanitizeSyncClaimRequest(input, now = new Date()) {
  const limit = input.limit == null ? 1 : Number(input.limit);
  if (!Number.isInteger(limit) || limit !== 1) {
    throw serviceError(400, 'invalid_sync_claim_request', 'Sync claims must request a limit of 1.');
  }

  const serverNow = now instanceof Date ? now : new Date(now);
  let runStartedAt = serverNow;
  if (input.run_started_at) {
    runStartedAt = new Date(String(input.run_started_at));
    if (
      !Number.isFinite(runStartedAt.getTime()) ||
      runStartedAt > serverNow ||
      serverNow.getTime() - runStartedAt.getTime() > SYNC_CLAIM_RUN_MAX_AGE_MS
    ) {
      throw serviceError(
        400,
        'invalid_sync_claim_request',
        'run_started_at must be a recent server-issued timestamp that is not in the future.'
      );
    }
  }

  return { limit, run_started_at: runStartedAt };
}

async function handleRoute(request, rawBody, body, dependencies) {
  const { config, store } = dependencies;
  const stripeClient = dependencies.stripeClient || new StripeApiClient({ secretKey: config.stripeSecretKey });
  const url = new URL(request.url, 'http://service.local');
  const context = {
    defaultSiteLimit: config.siteLimitDefault,
    encryptionKey: config.encryptionKey,
    now: dependencies.now ? dependencies.now() : new Date(),
    priceMap: config.stripePriceIds
  };

  if (request.method === 'GET' && url.pathname === '/health') {
    return { status: 200, payload: { ok: true } };
  }

  if (request.method === 'GET' && url.pathname === '/ready') {
    try {
      const readiness = typeof store.healthCheck === 'function'
        ? await store.healthCheck(context)
        : { ok: true, store: 'unknown' };

      return {
        status: readiness.ok === false ? 503 : 200,
        payload: {
          ok: readiness.ok !== false,
          ...readiness
        }
      };
    } catch (error) {
      return {
        status: 503,
        payload: {
          ok: false,
          error: error.message || 'Readiness check failed.'
        }
      };
    }
  }

  if (request.method === 'POST' && url.pathname === '/v1/billing/checkout') {
    const email = sanitizeEmail(body.email);
    const checkoutSite = sanitizeCheckoutSite(body);
    const { plan, priceId } = planPriceId(body.plan, config);
    const successUrl = configuredUrl(config.stripeCheckoutSuccessUrl, '', 'checkout_success_url_not_configured');
    const cancelUrl = configuredUrl(config.stripeCheckoutCancelUrl, '', 'checkout_cancel_url_not_configured');

    const recoveryToken = randomSecret('recover', 32);
    const recoveryId = randomSecret('recovery', 16);
    const recoveryExpiresAt = new Date(context.now.getTime() + CHECKOUT_RECOVERY_MAX_AGE_MS);
    const billing = await store.createBillingAccount({
      email,
      site_limit: config.siteLimitDefault,
      recovery_id: recoveryId,
      recovery_token_hash: sha256Hex(recoveryToken),
      recovery_expires_at: recoveryExpiresAt,
      ...checkoutSite
    }, context);

    let stripeCustomerId = billing.account.stripe_customer_id || '';
    if (!stripeCustomerId) {
      const customer = await stripeClient.createCustomer({
        email,
        metadata: {
          account_id: billing.account.id
        }
      });
      stripeCustomerId = customer.id;
      await store.attachStripeCustomer(billing.account.id, stripeCustomerId, context);
    }

    const session = await stripeClient.createCheckoutSession({
      mode: 'subscription',
      customer: stripeCustomerId,
      client_reference_id: billing.account.id,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      subscription_data: {
        metadata: {
          account_id: billing.account.id,
          license_id: billing.license.id,
          plan
        }
      },
      metadata: {
        account_id: billing.account.id,
        license_id: billing.license.id,
        recovery_id: recoveryId,
        plan
      }
    });

    if (!session.id || !/^cs_[A-Za-z0-9_]+$/.test(session.id)) {
      throw serviceError(502, 'invalid_stripe_checkout', 'Stripe returned an invalid Checkout Session.');
    }
    await store.attachCheckoutSession(recoveryId, session.id, context);

    return {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
      payload: {
        checkout_url: session.url,
        checkout_session_id: session.id,
        recovery_token: recoveryToken,
        recovery_expires_at: recoveryExpiresAt.toISOString(),
        plan
      }
    };
  }

  if (request.method === 'POST' && url.pathname === '/v1/billing/checkout/recover') {
    const recoveryInput = sanitizeCheckoutRecovery(body);
    const recovery = await store.checkoutRecoveryFor({
      ...recoveryInput,
      token_hash: sha256Hex(recoveryInput.recovery_token)
    }, context);
    if (!recovery) {
      throw serviceError(404, 'checkout_recovery_unavailable', 'Checkout recovery is unavailable.');
    }
    if (typeof stripeClient.retrieveCheckoutSession !== 'function') {
      throw serviceError(500, 'stripe_reconciliation_unavailable', 'Stripe checkout verification is unavailable.');
    }
    const session = await stripeClient.retrieveCheckoutSession(recoveryInput.checkout_session_id);
    const metadata = session && session.metadata ? session.metadata : {};
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer && session.customer.id;
    const subscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription && session.subscription.id;
    if (
      !session || session.id !== recovery.checkout_session_id ||
      session.mode !== 'subscription' || session.status !== 'complete' ||
      !subscriptionId || customerId !== recovery.stripe_customer_id ||
      metadata.account_id !== recovery.account_id ||
      metadata.license_id !== recovery.license_id || metadata.recovery_id !== recovery.id
    ) {
      throw serviceError(409, 'checkout_not_ready', 'Checkout is not complete or could not be verified.');
    }

    const currentSubscription = await stripeClient.retrieveSubscription(subscriptionId);
    const subscription = subscriptionFromStripeObject(currentSubscription);
    if (
      !subscription ||
      subscription.stripe_subscription_id !== subscriptionId ||
      subscription.stripe_customer_id !== recovery.stripe_customer_id
    ) {
      throw serviceError(503, 'stripe_reconciliation_failed', 'Stripe did not return a current subscription object.');
    }
    subscription.account_id = recovery.account_id;
    subscription.stripe_reconciliation_sequence = await store.nextStripeReconciliationSequence(context);
    const storedSubscription = await store.applyStripeSubscription(subscription, context);
    const entitlement = buildEntitlement(storedSubscription, context.priceMap, context.now);
    if (!entitlement.eligible) {
      throw serviceError(409, 'checkout_not_ready', 'Subscription activation is still processing. Try again shortly.');
    }

    const licenseKey = recoveryLicenseKey(
      config.encryptionKey,
      recoveryInput.checkout_session_id,
      recoveryInput.recovery_token
    );
    const rotated = await store.rotateLicenseForRecovery(
      recovery.id,
      licenseHash(licenseKey),
      licenseKey.slice(-4),
      context
    );
    if (!rotated) {
      throw serviceError(410, 'checkout_recovery_unavailable', 'Checkout recovery is unavailable.');
    }
    return {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      payload: { license_key: licenseKey, entitlement }
    };
  }

  if (request.method === 'POST' && url.pathname === '/v1/billing/portal') {
    let account;
    const token = bearerToken(request);
    if (token) {
      const siteContext = await requireSite(request, store, context);
      account = await store.billingAccountForSite(siteContext.site.id);
    } else if (body.license_key) {
      account = await store.billingAccountForLicenseHash(licenseHash(body.license_key));
    } else {
      throw serviceError(401, 'billing_auth_required', 'Bearer activation token or license_key is required.');
    }

    if (!account || !account.stripe_customer_id) {
      throw serviceError(404, 'billing_account_not_found', 'Billing account or Stripe customer was not found.');
    }

    const portal = await stripeClient.createPortalSession({
      customer: account.stripe_customer_id,
      return_url: configuredUrl(config.stripePortalReturnUrl, '', 'portal_return_url_not_configured')
    });

    return {
      status: 200,
      payload: {
        portal_url: portal.url
      }
    };
  }

  if (request.method === 'POST' && url.pathname === '/v1/licenses/activate') {
    const licenseKey = String(body.license_key || '').trim();
    const installationId = String(body.installation_id || '').trim();
    if (!licenseKey || !installationId || !body.delivery_url) {
      throw serviceError(400, 'invalid_activation_request', 'license_key, installation_id, and delivery_url are required.');
    }

    let siteUrl;
    try {
      siteUrl = normalizeSiteOrigin(body.site_url);
    } catch (error) {
      throw serviceError(400, 'invalid_site_url', 'site_url must be a valid http or https URL.');
    }

    const deliveryUrl = normalizeDeliveryUrl(body.delivery_url, siteUrl, config);

    const activation = await store.activateSite({
      license_key_hash: licenseHash(licenseKey),
      site_url: siteUrl,
      installation_id: installationId,
      delivery_url: deliveryUrl,
      plugin_version: String(body.plugin_version || ''),
      policy: sanitizePolicy(body.policy || {})
    }, context);

    return {
      status: 201,
      payload: {
        site_id: activation.site.id,
        activation_token: activation.activation_token,
        signing_secret: activation.signing_secret,
        entitlement: activation.entitlement
      }
    };
  }

  if (request.method === 'GET' && url.pathname === '/v1/licenses/status') {
    const { site, entitlement, connection } = await requireSite(request, store, context);
    return {
      status: 200,
      payload: {
        site_id: site.id,
        site_url: site.site_url,
        entitlement,
        connection: connectionStatus(connection),
        sync: syncStatusForSite(site)
      }
    };
  }

  if (request.method === 'DELETE' && url.pathname === '/v1/licenses/activation') {
    const { site } = await requireSite(request, store, context);
    await store.revokeSite(site.id, context);
    return {
      status: 200,
      payload: { revoked: true }
    };
  }

  if (request.method === 'PUT' && url.pathname === '/v1/connections/servicetitan') {
    const { site } = await requireSite(request, store, context);
    const connection = await store.connectServiceTitan(site.id, sanitizeConnection(body), context);
    return {
      status: 200,
      payload: {
        connected: true,
        tenant_id: connection.tenant_id,
        environment: connection.environment,
        updated_at: isoStringOrNull(connection.updated_at)
      }
    };
  }

  if (request.method === 'PUT' && url.pathname === '/v1/sites/policy') {
    const { site } = await requireSite(request, store, context);
    const policy = await store.updatePolicy(site.id, sanitizePolicy(body), context);
    return {
      status: 200,
      payload: {
        updated: true,
        policy
      }
    };
  }

  if (request.method === 'POST' && url.pathname === '/internal/v1/sync/claims') {
    requireWorker(request, config);
    const claimRequest = sanitizeSyncClaimRequest(body, context.now);
    const claims = await store.listEligibleSyncClaims({
      ...context,
      claimLimit: claimRequest.limit,
      runStartedAt: claimRequest.run_started_at
    });
    return {
      status: 200,
      payload: {
        sites: claims,
        run_started_at: claimRequest.run_started_at.toISOString()
      }
    };
  }

  if (request.method === 'POST' && url.pathname === '/internal/v1/sync/authorize') {
    requireWorker(request, config);
    const authorization = await store.authorizeSyncDelivery(sanitizeSyncAuthorization(body), context);
    return {
      status: 200,
      payload: authorization
    };
  }

  if (request.method === 'POST' && url.pathname === '/internal/v1/sync/runs') {
    requireWorker(request, config);
    const run = await store.recordSyncRun(sanitizeSyncRun(body), context);
    return {
      status: 200,
      payload: {
        updated: true,
        ...run
      }
    };
  }

  if (request.method === 'POST' && url.pathname === '/v1/stripe/webhooks') {
    verifyStripeSignature(rawBody, request.headers['stripe-signature'], config.stripeWebhookSecret, {
      now: Math.floor(context.now.getTime() / 1000)
    });
    const event = parseJson(rawBody);
    if (!event.id || !event.type) {
      throw serviceError(400, 'invalid_stripe_event', 'Stripe event id and type are required.');
    }
    if (
      typeof store.hasProcessedStripeWebhook === 'function' &&
      await store.hasProcessedStripeWebhook(event.id, context)
    ) {
      return {
        status: 200,
        payload: { received: true, duplicate: true }
      };
    }

    let subscription = subscriptionFromStripeObject(event.data && event.data.object, event.type);
    if (subscription) {
      if (typeof stripeClient.retrieveSubscription !== 'function') {
        throw serviceError(500, 'stripe_reconciliation_unavailable', 'Stripe subscription reconciliation is unavailable.');
      }
      const currentSubscription = await stripeClient.retrieveSubscription(subscription.stripe_subscription_id);
      subscription = subscriptionFromStripeObject(currentSubscription);
      if (!subscription) {
        throw serviceError(503, 'stripe_reconciliation_failed', 'Stripe did not return a current subscription object.');
      }
      if (typeof store.nextStripeReconciliationSequence !== 'function') {
        throw serviceError(500, 'stripe_reconciliation_unavailable', 'Stripe reconciliation ordering is unavailable.');
      }
      subscription.stripe_reconciliation_sequence = await store.nextStripeReconciliationSequence(context);
      const eventCreated = Number(event.created);
      if (!Number.isFinite(eventCreated) || eventCreated <= 0) {
        throw serviceError(400, 'invalid_stripe_event', 'Stripe subscription events require a valid created timestamp.');
      }
      subscription.stripe_event_created = eventCreated;
    }

    const processed = await store.processStripeWebhook(event, subscription, context);
    if (!processed) {
      return {
        status: 200,
        payload: { received: true, duplicate: true }
      };
    }

    return {
      status: 200,
      payload: { received: true }
    };
  }

  throw serviceError(404, 'not_found', 'Route not found.');
}

function createApp(dependencies) {
  if (!dependencies || !dependencies.store) {
    throw new Error('createApp requires a store');
  }
  const resolved = {
    ...dependencies,
    config: {
      ...createConfig(),
      ...(dependencies.config || {})
    }
  };

  return async function app(request, response) {
    try {
      const rawBody = await readRawBody(request);
      const body = rawBody ? parseJson(rawBody) : {};
      const result = await handleRoute(request, rawBody, body, resolved);
      jsonResponse(response, result.status, result.payload, result.headers);
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 500;
      const code = error instanceof ServiceError ? error.code : 'internal_error';
      const message = error instanceof ServiceError ? error.message : 'Internal server error.';
      jsonResponse(response, status, { error: message, code });
    }
  };
}

module.exports = {
  createApp,
  configuredUrl,
  handleRoute,
  normalizeDeliveryUrl,
  planPriceId,
  sanitizeConnection,
  sanitizeCheckoutRecovery,
  sanitizeCheckoutSite,
  sanitizeEmail,
  sanitizePolicy,
  sanitizeSyncClaimRequest,
  sanitizeSyncRun,
  recoveryLicenseKey
};
