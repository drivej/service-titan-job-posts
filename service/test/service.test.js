'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { handleRoute } = require('../src/app');
const { licenseHash } = require('../src/crypto');
const { ServiceError } = require('../src/errors');
const { MemoryStore } = require('../src/store/memory-store');
const { stripeSignatureHeader } = require('../src/stripe');

const FIXED_NOW = new Date('2026-07-07T12:00:00.000Z');

function createSeed(status = 'active') {
  return {
    accounts: [{
      id: 'acct_1',
      email: 'owner@example.test',
      stripe_customer_id: 'cus_123'
    }],
    licenses: [{
      id: 'lic_1',
      account_id: 'acct_1',
      key_hash: licenseHash('LOCAL-TEST-LICENSE'),
      site_limit: 1,
      active: true
    }],
    subscriptions: [{
      account_id: 'acct_1',
      stripe_subscription_id: 'sub_123',
      stripe_customer_id: 'cus_123',
      status,
      price_id: 'price_monthly',
      current_period_end: '2026-08-01T00:00:00.000Z'
    }]
  };
}

async function withService(store, callback, harnessOptions = {}) {
  const config = {
    encryptionKey: 'test-encryption-key',
    workerApiKey: 'worker-secret',
    stripeWebhookSecret: 'whsec_test',
    stripeSecretKey: 'sk_test',
    stripeCheckoutSuccessUrl: 'https://billing.example/success',
    stripeCheckoutCancelUrl: 'https://billing.example/cancel',
    stripePortalReturnUrl: 'https://billing.example/account',
    stripePriceIds: {
      monthly: 'price_monthly',
      yearly: 'price_yearly'
    },
    siteLimitDefault: 1,
    ...(harnessOptions.config || {})
  };
  const request = async (path, requestOptions = {}) => {
    const headers = {};
    for (const [key, value] of Object.entries(requestOptions.headers || {})) {
      headers[key.toLowerCase()] = value;
    }

    let rawBody = '';
    let body = {};
    if (requestOptions.body && typeof requestOptions.body === 'string') {
      rawBody = requestOptions.body;
      body = JSON.parse(rawBody);
    } else if (requestOptions.body) {
      rawBody = JSON.stringify(requestOptions.body);
      body = requestOptions.body;
      headers['content-type'] = 'application/json';
    }

    try {
      const result = await handleRoute(
        { method: requestOptions.method || 'GET', url: path, headers },
        rawBody,
        body,
        { config, store, stripeClient: harnessOptions.stripeClient, now: () => FIXED_NOW }
      );
      return { response: { status: result.status }, json: result.payload };
    } catch (error) {
      if (error instanceof ServiceError) {
        return {
          response: { status: error.status },
          json: { error: error.message, code: error.code }
        };
      }
      throw error;
    }
  };

  await callback({ request, config });
}

async function activate(request) {
  const { response, json } = await request('/v1/licenses/activate', {
    method: 'POST',
    body: {
      license_key: 'LOCAL-TEST-LICENSE',
      site_url: 'https://Example.com/some/path?x=1',
      installation_id: 'wp-install-1',
      delivery_url: 'https://example.com/wp-json/st-sync/v1/jobs',
      plugin_version: '2.0.0',
      policy: {
        min_price: '250',
        min_summary_words: '5',
        ignored: 'nope'
      }
    }
  });
  assert.equal(response.status, 201);
  assert.equal(json.entitlement.eligible, true);
  assert.equal(json.entitlement.plan, 'monthly');
  return json;
}

test('activates an eligible subscription and returns only activation-time secrets', async () => {
  const store = new MemoryStore(createSeed());
  await withService(store, async ({ request }) => {
    const activation = await activate(request);
    assert.match(activation.site_id, /^site_/);
    assert.match(activation.activation_token, /^act_/);
    assert.match(activation.signing_secret, /^sig_/);

    const persisted = store.dump();
    assert.equal(JSON.stringify(persisted).includes('LOCAL-TEST-LICENSE'), false);
    assert.equal(JSON.stringify(persisted).includes(activation.activation_token), false);
    assert.equal(JSON.stringify(persisted).includes(activation.signing_secret), false);
    assert.equal(persisted.sites[0].policy.min_price, '250');
    assert.equal(persisted.sites[0].policy.ignored, undefined);
  });
});

test('license site limits prevent one subscription from activating multiple websites', async () => {
  const store = new MemoryStore(createSeed());
  await withService(store, async ({ request }) => {
    const first = await activate(request);
    assert.match(first.site_id, /^site_/);

    const second = await request('/v1/licenses/activate', {
      method: 'POST',
      body: {
        license_key: 'LOCAL-TEST-LICENSE',
        site_url: 'https://second.example.com',
        installation_id: 'wp-install-2',
        delivery_url: 'https://second.example.com/wp-json/st-sync/v1/jobs',
        plugin_version: '2.0.0'
      }
    });

    assert.equal(second.response.status, 409);
    assert.equal(second.json.code, 'site_limit_reached');
  });
});

test('health and readiness endpoints distinguish process liveness from dependency readiness', async () => {
  const store = new MemoryStore(createSeed());
  await withService(store, async ({ request }) => {
    const health = await request('/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.json.ok, true);

    const ready = await request('/ready');
    assert.equal(ready.response.status, 200);
    assert.equal(ready.json.ok, true);
    assert.equal(ready.json.store, 'memory');
  });

  const failingStore = {
    async healthCheck() {
      throw new Error('database unavailable');
    }
  };
  await withService(failingStore, async ({ request }) => {
    const ready = await request('/ready');
    assert.equal(ready.response.status, 503);
    assert.equal(ready.json.ok, false);
    assert.equal(ready.json.error, 'database unavailable');
  });
});

test('activation rejects cross-origin or non-plugin delivery URLs', async () => {
  const store = new MemoryStore(createSeed());
  await withService(store, async ({ request }) => {
    const crossOrigin = await request('/v1/licenses/activate', {
      method: 'POST',
      body: {
        license_key: 'LOCAL-TEST-LICENSE',
        site_url: 'https://example.com',
        installation_id: 'wp-install-1',
        delivery_url: 'https://attacker.example/wp-json/st-sync/v1/jobs'
      }
    });
    assert.equal(crossOrigin.response.status, 400);
    assert.equal(crossOrigin.json.code, 'invalid_delivery_url');

    const wrongPath = await request('/v1/licenses/activate', {
      method: 'POST',
      body: {
        license_key: 'LOCAL-TEST-LICENSE',
        site_url: 'https://example.com',
        installation_id: 'wp-install-1',
        delivery_url: 'https://example.com/wp-json/wp/v2/posts'
      }
    });
    assert.equal(wrongPath.response.status, 400);
    assert.equal(wrongPath.json.code, 'invalid_delivery_url');
  });
});

test('checkout creates a license but activation stays blocked until Stripe marks the subscription active', async () => {
  const store = new MemoryStore();
  const stripeCalls = [];
  const stripeClient = {
    async createCustomer(values) {
      stripeCalls.push(['customer', values]);
      return { id: 'cus_checkout' };
    },
    async createCheckoutSession(values) {
      stripeCalls.push(['checkout', values]);
      return { id: 'cs_123', url: 'https://checkout.stripe.test/cs_123' };
    }
  };

  await withService(store, async ({ request, config }) => {
    const checkout = await request('/v1/billing/checkout', {
      method: 'POST',
      body: {
        email: 'Owner@Example.com',
        plan: 'yearly',
        success_url: 'https://attacker.example/success'
      }
    });

    assert.equal(checkout.response.status, 201);
    assert.match(checkout.json.license_key, /^LIC_/);
    assert.equal(checkout.json.checkout_url, 'https://checkout.stripe.test/cs_123');
    assert.equal(stripeCalls[0][1].email, 'owner@example.com');
    assert.equal(stripeCalls[1][1].mode, 'subscription');
    assert.equal(stripeCalls[1][1].line_items[0].price, 'price_yearly');
    assert.equal(stripeCalls[1][1].success_url, config.stripeCheckoutSuccessUrl);
    assert.notEqual(stripeCalls[1][1].success_url, 'https://attacker.example/success');

    const persistedBeforeWebhook = JSON.stringify(store.dump());
    assert.equal(persistedBeforeWebhook.includes(checkout.json.license_key), false);

    const blockedActivation = await request('/v1/licenses/activate', {
      method: 'POST',
      body: {
        license_key: checkout.json.license_key,
        site_url: 'https://example.com',
        installation_id: 'wp-install-1',
        delivery_url: 'https://example.com/wp-json/st-sync/v1/jobs'
      }
    });
    assert.equal(blockedActivation.response.status, 402);

    const accountId = store.dump().accounts[0].id;
    const event = {
      id: 'evt_checkout_active',
      type: 'customer.subscription.updated',
      created: 1783425540,
      data: {
        object: {
          id: 'sub_checkout',
          object: 'subscription',
          customer: 'cus_checkout',
          status: 'active',
          current_period_end: 1814400000,
          metadata: { account_id: accountId },
          items: {
            data: [{
              price: { id: 'price_yearly' },
              current_period_end: 1814400000
            }]
          }
        }
      }
    };
    const raw = JSON.stringify(event);
    const webhook = await request('/v1/stripe/webhooks', {
      method: 'POST',
      headers: {
        'Stripe-Signature': stripeSignatureHeader(raw, config.stripeWebhookSecret, Math.floor(FIXED_NOW.getTime() / 1000))
      },
      body: raw
    });
    assert.equal(webhook.response.status, 200);

    const activated = await request('/v1/licenses/activate', {
      method: 'POST',
      body: {
        license_key: checkout.json.license_key,
        site_url: 'https://example.com',
        installation_id: 'wp-install-1',
        delivery_url: 'https://example.com/wp-json/st-sync/v1/jobs'
      }
    });
    assert.equal(activated.response.status, 201);
    assert.equal(activated.json.entitlement.eligible, true);
    assert.equal(activated.json.entitlement.plan, 'yearly');
  }, { stripeClient });
});

test('billing portal requires license or activation auth and uses server-configured return URL', async () => {
  const store = new MemoryStore(createSeed());
  const stripeCalls = [];
  const stripeClient = {
    async createPortalSession(values) {
      stripeCalls.push(values);
      return { url: 'https://billing.stripe.test/session' };
    }
  };

  await withService(store, async ({ request, config }) => {
    const missingAuth = await request('/v1/billing/portal', {
      method: 'POST',
      body: {}
    });
    assert.equal(missingAuth.response.status, 401);

    const portal = await request('/v1/billing/portal', {
      method: 'POST',
      body: {
        license_key: 'LOCAL-TEST-LICENSE',
        return_url: 'https://attacker.example/return'
      }
    });
    assert.equal(portal.response.status, 200);
    assert.equal(portal.json.portal_url, 'https://billing.stripe.test/session');
    assert.equal(stripeCalls[0].customer, 'cus_123');
    assert.equal(stripeCalls[0].return_url, config.stripePortalReturnUrl);
  }, { stripeClient });
});

test('rejects activation when the server-side subscription is not eligible', async () => {
  const store = new MemoryStore(createSeed('past_due'));
  await withService(store, async ({ request }) => {
    const { response, json } = await request('/v1/licenses/activate', {
      method: 'POST',
      body: {
        license_key: 'LOCAL-TEST-LICENSE',
        site_url: 'https://example.com',
        installation_id: 'wp-install-1',
        delivery_url: 'https://example.com/wp-json/st-sync/v1/jobs'
      }
    });

    assert.equal(response.status, 402);
    assert.equal(json.code, 'subscription_required');
  });
});

test('stores ServiceTitan credentials encrypted and returns claims only to the worker', async () => {
  const store = new MemoryStore(createSeed());
  await withService(store, async ({ request }) => {
    const activation = await activate(request);
    const auth = { Authorization: `Bearer ${activation.activation_token}` };

    const status = await request('/v1/licenses/status', { headers: auth });
    assert.equal(status.response.status, 200);
    assert.equal(status.json.site_url, 'https://example.com');
    assert.deepEqual(status.json.sync, {
      last_successful_sync_at: null,
      last_sync_attempt_at: null,
      last_sync_status: '',
      last_sync_error: '',
      last_sync_stats: {}
    });
    assert.deepEqual(status.json.connection, {
      connected: false,
      tenant_id: '',
      environment: '',
      updated_at: null
    });

    const unconnectedClaims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    assert.equal(unconnectedClaims.response.status, 200);
    assert.equal(unconnectedClaims.json.sites.length, 0);

    const connection = await request('/v1/connections/servicetitan', {
      method: 'PUT',
      headers: auth,
      body: {
        tenant_id: '123456',
        client_id: 'st_client',
        client_secret: 'st_secret',
        environment: 'integration'
      }
    });
    assert.equal(connection.response.status, 200);
    assert.deepEqual(connection.json, {
      connected: true,
      tenant_id: '123456',
      environment: 'integration',
      updated_at: '2026-07-07T12:00:00.000Z'
    });

    const connectedStatus = await request('/v1/licenses/status', { headers: auth });
    assert.equal(connectedStatus.response.status, 200);
    assert.deepEqual(connectedStatus.json.connection, {
      connected: true,
      tenant_id: '123456',
      environment: 'integration',
      updated_at: '2026-07-07T12:00:00.000Z'
    });

    const policy = await request('/v1/sites/policy', {
      method: 'PUT',
      headers: auth,
      body: {
        min_price: '500',
        service_mappings: '123=plumbing',
        ignored: 'not persisted'
      }
    });
    assert.equal(policy.response.status, 200);
    assert.equal(policy.json.policy.ignored, undefined);

    const persisted = store.dump();
    assert.equal(JSON.stringify(persisted).includes('st_secret'), false);

    const unauthorized = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
      body: {}
    });
    assert.equal(unauthorized.response.status, 401);

    const claims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    assert.equal(claims.response.status, 200);
    assert.equal(claims.json.sites.length, 1);
    assert.match(claims.json.sites[0].claim_id, /^claim_/);
    assert.equal(claims.json.sites[0].sync_claimed_until, '2026-07-07T12:30:00.000Z');
    assert.equal(claims.json.sites[0].service_titan.client_secret, 'st_secret');
    assert.equal(claims.json.sites[0].policy.min_price, '500');
    assert.equal(claims.json.sites[0].signing_secret, activation.signing_secret);
    assert.equal(claims.json.sites[0].modified_before, '2026-07-07T12:00:00.000Z');
  });
});

test('sync claims use policy backfill first, then successful runs advance the cursor with overlap', async () => {
  const store = new MemoryStore(createSeed());
  await withService(store, async ({ request }) => {
    const activation = await activate(request);
    const auth = { Authorization: `Bearer ${activation.activation_token}` };
    await request('/v1/connections/servicetitan', {
      method: 'PUT',
      headers: auth,
      body: {
        tenant_id: '123456',
        client_id: 'st_client',
        client_secret: 'st_secret',
        environment: 'production'
      }
    });
    await request('/v1/sites/policy', {
      method: 'PUT',
      headers: auth,
      body: {
        jobs_since: '2026-07-01',
        min_price: '500'
      }
    });

    const initialClaims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    const initialClaim = initialClaims.json.sites[0];
    assert.equal(initialClaims.response.status, 200);
    assert.match(initialClaim.claim_id, /^claim_/);
    assert.equal(initialClaim.sync_claimed_until, '2026-07-07T12:30:00.000Z');
    assert.equal(initialClaim.modified_on_or_after, '2026-07-01T00:00:00Z');
    assert.equal(initialClaim.modified_before, '2026-07-07T12:00:00.000Z');

    const duplicateClaims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    assert.equal(duplicateClaims.response.status, 200);
    assert.deepEqual(duplicateClaims.json.sites, []);

    const unauthorizedRun = await request('/internal/v1/sync/runs', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
      body: {
        site_id: activation.site_id,
        claim_id: initialClaim.claim_id,
        status: 'success',
        processed_until: initialClaim.modified_before
      }
    });
    assert.equal(unauthorizedRun.response.status, 401);

    const successfulRun = await request('/internal/v1/sync/runs', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        site_id: activation.site_id,
        claim_id: initialClaim.claim_id,
        status: 'success',
        processed_until: initialClaim.modified_before,
        stats: {
          imported: 2,
          filtered: 3,
          failed: 0
        }
      }
    });
    assert.equal(successfulRun.response.status, 200);
    assert.equal(successfulRun.json.updated, true);
    assert.equal(successfulRun.json.last_sync_status, 'success');
    assert.equal(successfulRun.json.last_successful_sync_at, '2026-07-07T12:00:00.000Z');

    const advancedClaims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    const advancedClaim = advancedClaims.json.sites[0];
    assert.notEqual(advancedClaim.claim_id, initialClaim.claim_id);
    assert.equal(advancedClaim.modified_on_or_after, '2026-07-07T11:50:00.000Z');

    const staleSuccessRun = await request('/internal/v1/sync/runs', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        site_id: activation.site_id,
        claim_id: 'claim_stale',
        status: 'success',
        processed_until: '2026-07-01T00:00:00.000Z'
      }
    });
    assert.equal(staleSuccessRun.response.status, 200);
    assert.equal(staleSuccessRun.json.last_successful_sync_at, '2026-07-07T12:00:00.000Z');

    const failedRun = await request('/internal/v1/sync/runs', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        site_id: activation.site_id,
        claim_id: advancedClaim.claim_id,
        status: 'failed',
        processed_until: '2026-07-07T12:30:00.000Z',
        error: 'delivery failed',
        stats: {
          imported: 0,
          filtered: 0,
          failed: 1
        }
      }
    });
    assert.equal(failedRun.response.status, 200);
    assert.equal(failedRun.json.last_sync_status, 'failed');
    assert.equal(failedRun.json.last_successful_sync_at, '2026-07-07T12:00:00.000Z');

    const statusAfterFailure = await request('/v1/licenses/status', { headers: auth });
    assert.equal(statusAfterFailure.response.status, 200);
    assert.equal(statusAfterFailure.json.sync.last_successful_sync_at, '2026-07-07T12:00:00.000Z');
    assert.equal(statusAfterFailure.json.sync.last_sync_attempt_at, '2026-07-07T12:00:00.000Z');
    assert.equal(statusAfterFailure.json.sync.last_sync_status, 'failed');
    assert.equal(statusAfterFailure.json.sync.last_sync_error, 'delivery failed');
    assert.deepEqual(statusAfterFailure.json.sync.last_sync_stats, {
      imported: 0,
      filtered: 0,
      failed: 1
    });

    const afterFailureClaims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    assert.equal(afterFailureClaims.json.sites[0].modified_on_or_after, '2026-07-07T11:50:00.000Z');
  });
});

test('revoked activations preserve old content boundary by removing only future sync claims', async () => {
  const store = new MemoryStore(createSeed());
  await withService(store, async ({ request }) => {
    const activation = await activate(request);
    const auth = { Authorization: `Bearer ${activation.activation_token}` };
    await request('/v1/connections/servicetitan', {
      method: 'PUT',
      headers: auth,
      body: {
        tenant_id: '123456',
        client_id: 'st_client',
        client_secret: 'st_secret',
        environment: 'production'
      }
    });

    const deleted = await request('/v1/licenses/activation', {
      method: 'DELETE',
      headers: auth
    });
    assert.equal(deleted.response.status, 200);

    const claims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    assert.equal(claims.response.status, 200);
    assert.deepEqual(claims.json.sites, []);
  });
});

test('Stripe webhook signatures, idempotency, and event ordering protect subscription state', async () => {
  const store = new MemoryStore(createSeed());
  await withService(store, async ({ request, config }) => {
    const activation = await activate(request);
    const auth = { Authorization: `Bearer ${activation.activation_token}` };
    await request('/v1/connections/servicetitan', {
      method: 'PUT',
      headers: auth,
      body: {
        tenant_id: '123456',
        client_id: 'st_client',
        client_secret: 'st_secret',
        environment: 'production'
      }
    });

    const event = {
      id: 'evt_1',
      type: 'customer.subscription.deleted',
      created: 1783425600,
      data: {
        object: {
          id: 'sub_123',
          object: 'subscription',
          customer: 'cus_123',
          status: 'canceled',
          current_period_end: 1782864000,
          metadata: { account_id: 'acct_1' },
          items: {
            data: [{
              price: { id: 'price_monthly' },
              current_period_end: 1782864000
            }]
          }
        }
      }
    };
    const raw = JSON.stringify(event);

    const rejected = await request('/v1/stripe/webhooks', {
      method: 'POST',
      headers: { 'Stripe-Signature': 't=1,v1=bad' },
      body: raw
    });
    assert.equal(rejected.response.status, 400);

    const accepted = await request('/v1/stripe/webhooks', {
      method: 'POST',
      headers: {
        'Stripe-Signature': stripeSignatureHeader(raw, config.stripeWebhookSecret, Math.floor(FIXED_NOW.getTime() / 1000))
      },
      body: raw
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.json.received, true);

    const duplicate = await request('/v1/stripe/webhooks', {
      method: 'POST',
      headers: {
        'Stripe-Signature': stripeSignatureHeader(raw, config.stripeWebhookSecret, Math.floor(FIXED_NOW.getTime() / 1000))
      },
      body: raw
    });
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.json.duplicate, true);

    const staleActiveEvent = {
      ...event,
      id: 'evt_stale_active',
      type: 'customer.subscription.updated',
      created: event.created - 60,
      data: {
        object: {
          ...event.data.object,
          status: 'active'
        }
      }
    };
    const staleRaw = JSON.stringify(staleActiveEvent);
    const stale = await request('/v1/stripe/webhooks', {
      method: 'POST',
      headers: {
        'Stripe-Signature': stripeSignatureHeader(staleRaw, config.stripeWebhookSecret, Math.floor(FIXED_NOW.getTime() / 1000))
      },
      body: staleRaw
    });
    assert.equal(stale.response.status, 200);
    assert.equal(store.dump().subscriptions[0].status, 'canceled');

    const claims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    assert.equal(claims.response.status, 200);
    assert.deepEqual(claims.json.sites, []);
  });
});
