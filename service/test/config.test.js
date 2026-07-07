'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createConfig, validateProductionConfig } = require('../src/config');

test('development config does not require hosted production secrets', () => {
  const config = createConfig({});
  assert.deepEqual(validateProductionConfig(config, {}), []);
});

test('production config reports missing hosted-service secrets', () => {
  const config = createConfig({ NODE_ENV: 'production' });
  const errors = validateProductionConfig(config, { NODE_ENV: 'production' });

  assert.ok(errors.includes('DATABASE_URL is required'));
  assert.ok(errors.includes('WORKER_API_KEY is required'));
  assert.ok(errors.includes('SERVICE_ENCRYPTION_KEY must not use the development default'));
});

test('production config accepts complete HTTPS billing URLs', () => {
  const environment = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://example',
    SERVICE_ENCRYPTION_KEY: 'not-the-dev-key',
    WORKER_API_KEY: 'worker',
    STRIPE_SECRET_KEY: 'sk_live_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_MONTHLY_PRICE_ID: 'price_monthly',
    STRIPE_YEARLY_PRICE_ID: 'price_yearly',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://billing.example/success',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://billing.example/cancel',
    STRIPE_PORTAL_RETURN_URL: 'https://billing.example/account'
  };

  assert.deepEqual(validateProductionConfig(createConfig(environment), environment), []);
});
