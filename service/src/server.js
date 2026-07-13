'use strict';

require('dotenv').config({ quiet: true });

const http = require('http');
const { createApp } = require('./app');
const { createConfig, validateProductionConfig } = require('./config');
const { licenseHash } = require('./crypto');
const { MemoryStore } = require('./store/memory-store');
const { PostgresStore } = require('./store/postgres-store');

function createDevelopmentStore(config) {
  const licenseKey = process.env.DEV_LICENSE_KEY || '';
  if (!licenseKey) return new MemoryStore();

  return new MemoryStore({
    accounts: [{
      id: 'acct_dev',
      email: process.env.DEV_ACCOUNT_EMAIL || 'dev@example.test',
      stripe_customer_id: process.env.DEV_STRIPE_CUSTOMER_ID || 'cus_dev'
    }],
    licenses: [{
      id: 'lic_dev',
      account_id: 'acct_dev',
      key_hash: licenseHash(licenseKey),
      site_limit: config.siteLimitDefault,
      active: true
    }],
    subscriptions: [{
      account_id: 'acct_dev',
      stripe_subscription_id: 'sub_dev',
      stripe_customer_id: process.env.DEV_STRIPE_CUSTOMER_ID || 'cus_dev',
      status: process.env.DEV_SUBSCRIPTION_STATUS || 'active',
      price_id: config.stripePriceIds.monthly || 'price_dev_monthly',
      current_period_end: process.env.DEV_CURRENT_PERIOD_END || '2099-01-01T00:00:00.000Z'
    }]
  });
}

function createStore(config) {
  if (!process.env.DATABASE_URL) {
    return createDevelopmentStore(config);
  }

  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (error) {
    throw new Error('DATABASE_URL is set, but the pg package is not installed. Run npm install in service/.');
  }

  return new PostgresStore(new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: process.env.PGSSLMODE !== 'no-verify' }
  }));
}

function main() {
  const config = createConfig(process.env);
  const configErrors = validateProductionConfig(config, process.env);
  if (configErrors.length > 0) {
    throw new Error(`Hosted service configuration is invalid:\n- ${configErrors.join('\n- ')}`);
  }

  const store = createStore(config);
  const server = http.createServer(createApp({ config, store }));
  server.listen(config.port, () => {
    console.log(`ServiceTitan Local Job Content service listening on ${config.port}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  createDevelopmentStore,
  createStore,
  main
};
