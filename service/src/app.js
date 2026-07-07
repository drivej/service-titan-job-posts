'use strict';

const { createConfig } = require('./config');
const { licenseHash, normalizeSiteOrigin, sha256Hex, timingSafeEqualString } = require('./crypto');
const { ServiceError, serviceError } = require('./errors');
const { StripeApiClient } = require('./stripe-client');
const { subscriptionFromStripeObject, verifyStripeSignature } = require('./stripe');

const JSON_LIMIT_BYTES = 1024 * 1024;
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

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
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

  if (request.method === 'POST' && url.pathname === '/v1/billing/checkout') {
    const email = sanitizeEmail(body.email);
    const { plan, priceId } = planPriceId(body.plan, config);
    const successUrl = configuredUrl(config.stripeCheckoutSuccessUrl, '', 'checkout_success_url_not_configured');
    const cancelUrl = configuredUrl(config.stripeCheckoutCancelUrl, '', 'checkout_cancel_url_not_configured');

    const billing = await store.createBillingAccount({
      email,
      site_limit: config.siteLimitDefault
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
        plan
      }
    });

    return {
      status: 201,
      payload: {
        checkout_url: session.url,
        checkout_session_id: session.id,
        license_key: billing.license_key,
        plan
      }
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
    const { site, entitlement } = await requireSite(request, store, context);
    return {
      status: 200,
      payload: {
        site_id: site.id,
        site_url: site.site_url,
        entitlement
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
        environment: connection.environment
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
    const claims = await store.listEligibleSyncClaims(context);
    return {
      status: 200,
      payload: {
        sites: claims
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

    const firstSeen = await store.recordWebhookEvent(event.id, event.type);
    if (!firstSeen) {
      return {
        status: 200,
        payload: { received: true, duplicate: true }
      };
    }

    const subscription = subscriptionFromStripeObject(event.data && event.data.object, event.type);
    if (subscription) {
      await store.applyStripeSubscription(subscription, context);
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
      jsonResponse(response, result.status, result.payload);
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
  sanitizeEmail,
  sanitizePolicy
};
