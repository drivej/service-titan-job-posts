'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { handleRoute } = require('../src/app');
const { licenseHash } = require('../src/crypto');
const { buildEntitlement, isEligibleSubscription } = require('../src/entitlements');
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
        {
          config,
          store,
          stripeClient: harnessOptions.stripeClient,
          now: harnessOptions.now || (() => FIXED_NOW)
        }
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
  let currentStripeSubscription = null;
  let currentCheckoutSession = null;
  const stripeClient = {
    async createCustomer(values) {
      stripeCalls.push(['customer', values]);
      return { id: 'cus_checkout' };
    },
    async createCheckoutSession(values) {
      stripeCalls.push(['checkout', values]);
      return { id: 'cs_123', url: 'https://checkout.stripe.test/cs_123' };
    },
    async retrieveSubscription(subscriptionId) {
      assert.equal(subscriptionId, 'sub_checkout');
      return currentStripeSubscription;
    },
    async retrieveCheckoutSession(sessionId) {
      assert.equal(sessionId, 'cs_123');
      return currentCheckoutSession;
    }
  };

  await withService(store, async ({ request, config }) => {
    const checkout = await request('/v1/billing/checkout', {
      method: 'POST',
      body: {
        email: 'Owner@Example.com',
        plan: 'yearly',
        installation_id: 'wp-install-1',
        site_url: 'https://example.com',
        success_url: 'https://attacker.example/success'
      }
    });

    assert.equal(checkout.response.status, 201);
    assert.equal(checkout.json.license_key, undefined);
    assert.match(checkout.json.recovery_token, /^recover_/);
    assert.equal(checkout.json.checkout_session_id, 'cs_123');
    assert.equal(checkout.json.checkout_url, 'https://checkout.stripe.test/cs_123');
    assert.equal(stripeCalls[0][1].email, 'owner@example.com');
    assert.equal(stripeCalls[1][1].mode, 'subscription');
    assert.equal(stripeCalls[1][1].line_items[0].price, 'price_yearly');
    assert.equal(stripeCalls[1][1].success_url, config.stripeCheckoutSuccessUrl);
    assert.notEqual(stripeCalls[1][1].success_url, 'https://attacker.example/success');

    const persistedBeforeWebhook = JSON.stringify(store.dump());
    assert.equal(persistedBeforeWebhook.includes(checkout.json.recovery_token), false);

    const wrongRecovery = await request('/v1/billing/checkout/recover', {
      method: 'POST',
      body: {
        checkout_session_id: checkout.json.checkout_session_id,
        recovery_token: `recover_${'z'.repeat(43)}`,
        site_url: 'https://example.com',
        installation_id: 'wp-install-1'
      }
    });
    assert.equal(wrongRecovery.response.status, 404);

    currentCheckoutSession = {
      id: 'cs_123',
      mode: 'subscription',
      status: 'open',
      customer: 'cus_checkout',
      subscription: null,
      metadata: stripeCalls[1][1].metadata
    };
    const blockedRecovery = await request('/v1/billing/checkout/recover', {
      method: 'POST',
      body: {
        checkout_session_id: checkout.json.checkout_session_id,
        recovery_token: checkout.json.recovery_token,
        site_url: 'https://example.com',
        installation_id: 'wp-install-1'
      }
    });
    assert.equal(blockedRecovery.response.status, 409);

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
    currentStripeSubscription = event.data.object;
    const raw = JSON.stringify(event);
    const webhook = await request('/v1/stripe/webhooks', {
      method: 'POST',
      headers: {
        'Stripe-Signature': stripeSignatureHeader(raw, config.stripeWebhookSecret, Math.floor(FIXED_NOW.getTime() / 1000))
      },
      body: raw
    });
    assert.equal(webhook.response.status, 200);

    currentCheckoutSession = {
      id: 'cs_123',
      mode: 'subscription',
      status: 'complete',
      customer: 'cus_checkout',
      subscription: 'sub_checkout',
      metadata: stripeCalls[1][1].metadata
    };
    const recovery = await request('/v1/billing/checkout/recover', {
      method: 'POST',
      body: {
        checkout_session_id: checkout.json.checkout_session_id,
        recovery_token: checkout.json.recovery_token,
        site_url: 'https://example.com',
        installation_id: 'wp-install-1'
      }
    });
    assert.equal(recovery.response.status, 200);
    assert.match(recovery.json.license_key, /^LIC_[A-F0-9]{48}$/);
    assert.equal(recovery.json.entitlement.eligible, true);

    const retriedRecovery = await request('/v1/billing/checkout/recover', {
      method: 'POST',
      body: {
        checkout_session_id: checkout.json.checkout_session_id,
        recovery_token: checkout.json.recovery_token,
        site_url: 'https://example.com',
        installation_id: 'wp-install-1'
      }
    });
    assert.equal(retriedRecovery.json.license_key, recovery.json.license_key);

    const activated = await request('/v1/licenses/activate', {
      method: 'POST',
      body: {
        license_key: recovery.json.license_key,
        site_url: 'https://example.com',
        installation_id: 'wp-install-1',
        delivery_url: 'https://example.com/wp-json/st-sync/v1/jobs'
      }
    });
    assert.equal(activated.response.status, 201);
    assert.equal(activated.json.entitlement.eligible, true);
    assert.equal(activated.json.entitlement.plan, 'yearly');
    assert.equal(JSON.stringify(store.dump()).includes(recovery.json.license_key), false);

    const completedRecovery = await request('/v1/billing/checkout/recover', {
      method: 'POST',
      body: {
        checkout_session_id: checkout.json.checkout_session_id,
        recovery_token: checkout.json.recovery_token,
        site_url: 'https://example.com',
        installation_id: 'wp-install-1'
      }
    });
    assert.equal(completedRecovery.response.status, 404);
  }, { stripeClient });
});

test('checkout cannot mint a license against an existing subscriber by reusing their email', async () => {
  const store = new MemoryStore(createSeed());
  const stripeCustomers = [];
  const stripeClient = {
    async createCustomer(values) {
      stripeCustomers.push(values);
      return { id: 'cus_isolated_checkout' };
    },
    async createCheckoutSession() {
      return { id: 'cs_isolated', url: 'https://checkout.stripe.test/cs_isolated' };
    }
  };

  await withService(store, async ({ request }) => {
    const checkout = await request('/v1/billing/checkout', {
      method: 'POST',
      body: {
        email: 'OWNER@example.test',
        plan: 'monthly',
        installation_id: 'wp-install-isolated',
        site_url: 'https://new-site.example'
      }
    });

    assert.equal(checkout.response.status, 201);
    assert.equal(stripeCustomers.length, 1);
    assert.equal(store.dump().accounts.length, 2);

    assert.equal(checkout.json.license_key, undefined);
    const newAccount = store.dump().accounts.find((account) => account.stripe_customer_id === 'cus_isolated_checkout');
    assert.notEqual(newAccount.id, 'acct_1');
    assert.equal(store.dump().subscriptions.some((subscription) => subscription.account_id === newAccount.id), false);
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

test('subscription entitlement requires an unpaused status and a valid future paid-through date', () => {
  const future = '2026-08-01T00:00:00.000Z';
  assert.equal(isEligibleSubscription({ status: 'active', current_period_end: future }, FIXED_NOW), true);
  assert.equal(isEligibleSubscription({
    status: 'active',
    current_period_end: future,
    cancel_at_period_end: true
  }, FIXED_NOW), true);
  assert.equal(isEligibleSubscription({
    status: 'active',
    current_period_end: FIXED_NOW.toISOString()
  }, FIXED_NOW), false);
  assert.equal(isEligibleSubscription({ status: 'active', current_period_end: '' }, FIXED_NOW), false);
  assert.equal(isEligibleSubscription({ status: 'trialing', current_period_end: 'invalid' }, FIXED_NOW), false);
  assert.equal(isEligibleSubscription({ status: 'paused', current_period_end: future }, FIXED_NOW), false);
  assert.equal(buildEntitlement({
    status: 'active',
    price_id: 'price_unrecognized',
    current_period_end: future
  }, { monthly: 'price_monthly', yearly: 'price_yearly' }, FIXED_NOW).eligible, false);
});

test('non-reconciled equal-timestamp updates keep the fail-closed subscription state', async () => {
  const store = new MemoryStore(createSeed());
  const base = {
    account_id: 'acct_1',
    stripe_subscription_id: 'sub_123',
    stripe_customer_id: 'cus_123',
    price_id: 'price_monthly',
    current_period_end: '2026-08-01T00:00:00.000Z',
    stripe_event_created: 1783425600
  };
  await store.applyStripeSubscription({ ...base, status: 'canceled' }, {});
  await store.applyStripeSubscription({ ...base, status: 'active' }, {});
  assert.equal(store.dump().subscriptions[0].status, 'canceled');
});

test('Stripe pause_collection immediately suspends claims even while Stripe reports active', async () => {
  const store = new MemoryStore(createSeed());
  let currentStripeSubscription = null;
  let stripeUnavailable = false;
  const stripeClient = {
    async retrieveSubscription(subscriptionId) {
      assert.equal(subscriptionId, 'sub_123');
      if (stripeUnavailable) throw new Error('Stripe temporarily unavailable');
      return currentStripeSubscription;
    }
  };
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

    const subscriptionObject = {
      id: 'sub_123',
      object: 'subscription',
      customer: 'cus_123',
      status: 'active',
      current_period_end: 1785542400,
      cancel_at_period_end: false,
      pause_collection: { behavior: 'void' },
      metadata: { account_id: 'acct_1' },
      items: {
        data: [{
          price: { id: 'price_monthly' },
          current_period_end: 1785542400
        }]
      }
    };
    const sendWebhook = async (id, created, object, currentObject = object) => {
      currentStripeSubscription = currentObject;
      const event = {
        id,
        type: 'customer.subscription.updated',
        created,
        data: { object }
      };
      const raw = JSON.stringify(event);
      return request('/v1/stripe/webhooks', {
        method: 'POST',
        headers: {
          'Stripe-Signature': stripeSignatureHeader(
            raw,
            config.stripeWebhookSecret,
            Math.floor(FIXED_NOW.getTime() / 1000)
          )
        },
        body: raw
      });
    };

    const paused = await sendWebhook('evt_collection_paused', 1783425600, subscriptionObject);
    assert.equal(paused.response.status, 200);
    assert.equal(store.dump().subscriptions[0].status, 'paused');

    const pausedStatus = await request('/v1/licenses/status', { headers: auth });
    assert.equal(pausedStatus.json.entitlement.status, 'paused');
    assert.equal(pausedStatus.json.entitlement.eligible, false);
    const pausedClaims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    assert.deepEqual(pausedClaims.json.sites, []);

    const resumed = await sendWebhook('evt_collection_resumed', 1783425600, {
      ...subscriptionObject,
      pause_collection: null
    });
    assert.equal(resumed.response.status, 200);
    assert.equal(store.dump().subscriptions[0].status, 'active');
    const resumedStatus = await request('/v1/licenses/status', { headers: auth });
    assert.equal(resumedStatus.json.entitlement.eligible, true);
    const resumedClaims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    assert.equal(resumedClaims.json.sites.length, 1);

    const delayedButAuthoritativePause = await sendWebhook(
      'evt_delayed_before_current_pause',
      1783425500,
      { ...subscriptionObject, pause_collection: null },
      subscriptionObject
    );
    assert.equal(delayedButAuthoritativePause.response.status, 200);
    const delayedPauseStatus = await request('/v1/licenses/status', { headers: auth });
    assert.equal(delayedPauseStatus.json.entitlement.status, 'paused');
    assert.equal(delayedPauseStatus.json.entitlement.eligible, false);

    stripeUnavailable = true;
    const duplicate = await sendWebhook(
      'evt_delayed_before_current_pause',
      1783425500,
      { ...subscriptionObject, pause_collection: null },
      subscriptionObject
    );
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.json.duplicate, true);
  }, { stripeClient });
});

test('concurrent Stripe reconciliations cannot restore an older active snapshot', async () => {
  let releaseFirst;
  let markFirstBlocked;
  const firstBlocked = new Promise((resolve) => {
    markFirstBlocked = resolve;
  });
  const firstRelease = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  class ReorderedWebhookStore extends MemoryStore {
    async processStripeWebhook(event, subscription, context) {
      if (event.id === 'evt_active_slow') {
        markFirstBlocked();
        await firstRelease;
      }
      return super.processStripeWebhook(event, subscription, context);
    }
  }

  const store = new ReorderedWebhookStore(createSeed());
  const baseSubscription = {
    id: 'sub_123',
    object: 'subscription',
    customer: 'cus_123',
    status: 'active',
    current_period_end: 1785542400,
    pause_collection: null,
    metadata: { account_id: 'acct_1' },
    items: { data: [{ price: { id: 'price_monthly' }, current_period_end: 1785542400 }] }
  };
  const snapshots = [
    baseSubscription,
    { ...baseSubscription, pause_collection: { behavior: 'void' } }
  ];
  const stripeClient = {
    async retrieveSubscription() {
      return snapshots.shift();
    }
  };

  await withService(store, async ({ request, config }) => {
    const webhookRequest = (id, created) => {
      const event = {
        id,
        type: 'customer.subscription.updated',
        created,
        data: { object: baseSubscription }
      };
      const raw = JSON.stringify(event);
      return request('/v1/stripe/webhooks', {
        method: 'POST',
        headers: {
          'Stripe-Signature': stripeSignatureHeader(
            raw,
            config.stripeWebhookSecret,
            Math.floor(FIXED_NOW.getTime() / 1000)
          )
        },
        body: raw
      });
    };

    const olderActive = webhookRequest('evt_active_slow', 1783425600);
    await firstBlocked;
    const newerPause = await webhookRequest('evt_pause_fast', 1783425601);
    assert.equal(newerPause.response.status, 200);
    releaseFirst();
    const lateActiveResult = await olderActive;
    assert.equal(lateActiveResult.response.status, 200);
    assert.equal(store.dump().subscriptions[0].status, 'paused');
    await store.applyStripeSubscription({
      account_id: 'acct_1',
      stripe_subscription_id: 'sub_123',
      stripe_customer_id: 'cus_123',
      status: 'active',
      price_id: 'price_monthly',
      current_period_end: '2026-08-01T00:00:00.000Z',
      stripe_event_created: 9999999999
    }, {});
    assert.equal(store.dump().subscriptions[0].status, 'paused');
  }, { stripeClient });
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

    const authorized = await request('/internal/v1/sync/authorize', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        site_id: activation.site_id,
        claim_id: claims.json.sites[0].claim_id
      }
    });
    assert.deepEqual(authorized.json, { authorized: true, reason: 'authorized' });

    const wrongClaim = await request('/internal/v1/sync/authorize', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: { site_id: activation.site_id, claim_id: 'claim_wrong' }
    });
    assert.deepEqual(wrongClaim.json, { authorized: false, reason: 'invalid_or_expired_claim' });

    const expired = await store.authorizeSyncDelivery({
      site_id: activation.site_id,
      claim_id: claims.json.sites[0].claim_id
    }, {
      now: new Date('2026-07-07T12:31:00.000Z'),
      priceMap: { monthly: 'price_monthly', yearly: 'price_yearly' }
    });
    assert.deepEqual(expired, { authorized: false, reason: 'invalid_or_expired_claim' });

    const subscription = store.dump().subscriptions[0];
    await store.applyStripeSubscription({
      ...subscription,
      status: 'canceled',
      stripe_event_created: 1783425600
    });
    const canceled = await request('/internal/v1/sync/authorize', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        site_id: activation.site_id,
        claim_id: claims.json.sites[0].claim_id
      }
    });
    assert.deepEqual(canceled.json, { authorized: false, reason: 'subscription_ineligible' });

    await store.revokeSite(activation.site_id, { now: FIXED_NOW });
    const revoked = await request('/internal/v1/sync/authorize', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        site_id: activation.site_id,
        claim_id: claims.json.sites[0].claim_id
      }
    });
    assert.deepEqual(revoked.json, { authorized: false, reason: 'site_unavailable' });
  });
});

test('sync claim requests enforce singleton batches and server-issued run timestamps', async () => {
  const store = new MemoryStore(createSeed());
  await withService(store, async ({ request }) => {
    for (const body of [
      { limit: 2 },
      { run_started_at: 'not-a-date' },
      { run_started_at: '2026-07-07T12:00:01.000Z' }
    ]) {
      const result = await request('/internal/v1/sync/claims', {
        method: 'POST',
        headers: { Authorization: 'Bearer worker-secret' },
        body
      });
      assert.equal(result.response.status, 400);
      assert.equal(result.json.code, 'invalid_sync_claim_request');
    }
  });
});

test('sync claims use policy backfill first, then successful runs advance the cursor with overlap', async () => {
  const store = new MemoryStore(createSeed());
  let currentNow = FIXED_NOW;
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

    const missingClaimRun = await request('/internal/v1/sync/runs', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        site_id: activation.site_id,
        status: 'success',
        processed_until: initialClaim.modified_before
      }
    });
    assert.equal(missingClaimRun.response.status, 400);
    assert.equal(missingClaimRun.json.code, 'invalid_sync_run');

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

    const completedRunClaims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: { limit: 1, run_started_at: initialClaims.json.run_started_at }
    });
    assert.deepEqual(completedRunClaims.json.sites, []);

    currentNow = new Date('2026-07-07T12:01:00.000Z');
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
        processed_until: '2026-07-08T00:00:00.000Z',
        stats: {
          imported: 999,
          filtered: 0,
          failed: 0
        }
      }
    });
    assert.equal(staleSuccessRun.response.status, 409);
    assert.equal(staleSuccessRun.json.code, 'stale_sync_claim');

    const staleFailureRun = await request('/internal/v1/sync/runs', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        site_id: activation.site_id,
        claim_id: 'claim_stale',
        status: 'failed',
        error: 'stale worker failure',
        stats: { imported: 0, filtered: 0, failed: 999 }
      }
    });
    assert.equal(staleFailureRun.response.status, 409);
    assert.equal(staleFailureRun.json.code, 'stale_sync_claim');

    const statusAfterStaleReports = await request('/v1/licenses/status', { headers: auth });
    assert.equal(statusAfterStaleReports.json.sync.last_successful_sync_at, '2026-07-07T12:00:00.000Z');
    assert.equal(statusAfterStaleReports.json.sync.last_sync_status, 'success');
    assert.deepEqual(statusAfterStaleReports.json.sync.last_sync_stats, {
      imported: 2,
      filtered: 3,
      failed: 0
    });

    const currentClaimAuthorization = await request('/internal/v1/sync/authorize', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        site_id: activation.site_id,
        claim_id: advancedClaim.claim_id
      }
    });
    assert.deepEqual(currentClaimAuthorization.json, { authorized: true, reason: 'authorized' });

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
    assert.equal(statusAfterFailure.json.sync.last_sync_attempt_at, '2026-07-07T12:01:00.000Z');
    assert.equal(statusAfterFailure.json.sync.last_sync_status, 'failed');
    assert.equal(statusAfterFailure.json.sync.last_sync_error, 'delivery failed');
    assert.deepEqual(statusAfterFailure.json.sync.last_sync_stats, {
      imported: 0,
      filtered: 0,
      failed: 1
    });

    currentNow = new Date('2026-07-07T12:02:00.000Z');
    const afterFailureClaims = await request('/internal/v1/sync/claims', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret' },
      body: {}
    });
    assert.equal(afterFailureClaims.json.sites[0].modified_on_or_after, '2026-07-07T11:50:00.000Z');
  }, { now: () => currentNow });
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
  let currentStripeSubscription = null;
  const stripeClient = {
    async retrieveSubscription(subscriptionId) {
      assert.equal(subscriptionId, 'sub_123');
      return currentStripeSubscription;
    }
  };
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
    currentStripeSubscription = event.data.object;
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
  }, { stripeClient });
});

test('Stripe webhook retries remain processable after a subscription update failure', async () => {
  class RetryableWebhookStore extends MemoryStore {
    constructor(seed) {
      super(seed);
      this.failNextSubscriptionUpdate = true;
    }

    async applyStripeSubscription(subscription, context) {
      if (this.failNextSubscriptionUpdate) {
        this.failNextSubscriptionUpdate = false;
        throw new Error('temporary subscription storage failure');
      }
      return super.applyStripeSubscription(subscription, context);
    }
  }

  const store = new RetryableWebhookStore(createSeed());
  let currentStripeSubscription = null;
  const stripeClient = {
    async retrieveSubscription(subscriptionId) {
      assert.equal(subscriptionId, 'sub_123');
      return currentStripeSubscription;
    }
  };
  await withService(store, async ({ request, config }) => {
    const event = {
      id: 'evt_retryable_cancel',
      type: 'customer.subscription.deleted',
      created: 1783425660,
      data: {
        object: {
          id: 'sub_123',
          object: 'subscription',
          customer: 'cus_123',
          status: 'canceled',
          current_period_end: 1782864000,
          metadata: { account_id: 'acct_1' },
          items: { data: [{ price: { id: 'price_monthly' } }] }
        }
      }
    };
    currentStripeSubscription = event.data.object;
    const raw = JSON.stringify(event);
    const headers = {
      'Stripe-Signature': stripeSignatureHeader(raw, config.stripeWebhookSecret, Math.floor(FIXED_NOW.getTime() / 1000))
    };

    await assert.rejects(
      request('/v1/stripe/webhooks', { method: 'POST', headers, body: raw }),
      /temporary subscription storage failure/
    );

    const retry = await request('/v1/stripe/webhooks', { method: 'POST', headers, body: raw });
    assert.equal(retry.response.status, 200);
    assert.equal(retry.json.duplicate, undefined);
    assert.equal(store.dump().subscriptions[0].status, 'canceled');

    const duplicate = await request('/v1/stripe/webhooks', { method: 'POST', headers, body: raw });
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.json.duplicate, true);
  }, { stripeClient });
});
