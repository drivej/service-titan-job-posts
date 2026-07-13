'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { StripeApiClient } = require('../src/stripe-client');

test('Stripe subscription reconciliation uses authenticated GET without a request body', async () => {
  const calls = [];
  const client = new StripeApiClient({
    secretKey: 'sk_test_reconcile',
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { id: 'sub_current', object: 'subscription', status: 'active' };
        }
      };
    }
  });

  const subscription = await client.retrieveSubscription('sub_current');
  assert.equal(subscription.id, 'sub_current');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/subscriptions/sub_current');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(Object.hasOwn(calls[0].options, 'body'), false);
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
  assert.throws(() => client.retrieveSubscription('../customers'), /Stripe subscription ID is invalid/);
});
