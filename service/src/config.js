'use strict';

function createConfig(environment = process.env) {
  return {
    port: Number.parseInt(environment.PORT || '8080', 10),
    publicBaseUrl: environment.PUBLIC_BASE_URL || '',
    encryptionKey: environment.SERVICE_ENCRYPTION_KEY || 'local-development-key-change-me',
    workerApiKey: environment.WORKER_API_KEY || '',
    stripeSecretKey: environment.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: environment.STRIPE_WEBHOOK_SECRET || '',
    stripeCheckoutSuccessUrl: environment.STRIPE_CHECKOUT_SUCCESS_URL || '',
    stripeCheckoutCancelUrl: environment.STRIPE_CHECKOUT_CANCEL_URL || '',
    stripePortalReturnUrl: environment.STRIPE_PORTAL_RETURN_URL || '',
    stripePriceIds: {
      monthly: environment.STRIPE_MONTHLY_PRICE_ID || '',
      yearly: environment.STRIPE_YEARLY_PRICE_ID || ''
    },
    siteLimitDefault: Math.max(1, Number.parseInt(environment.DEFAULT_SITE_LIMIT || '1', 10) || 1),
    allowInsecureLocalDelivery: environment.ALLOW_INSECURE_LOCAL_DELIVERY === 'true'
  };
}

function validateProductionConfig(config, environment = process.env) {
  const productionLike = environment.NODE_ENV === 'production' || Boolean(environment.DATABASE_URL);
  if (!productionLike) return [];

  const missing = [];
  const required = [
    ['DATABASE_URL', environment.DATABASE_URL],
    ['SERVICE_ENCRYPTION_KEY', config.encryptionKey],
    ['WORKER_API_KEY', config.workerApiKey],
    ['STRIPE_SECRET_KEY', config.stripeSecretKey],
    ['STRIPE_WEBHOOK_SECRET', config.stripeWebhookSecret],
    ['STRIPE_MONTHLY_PRICE_ID', config.stripePriceIds.monthly],
    ['STRIPE_YEARLY_PRICE_ID', config.stripePriceIds.yearly],
    ['STRIPE_CHECKOUT_SUCCESS_URL', config.stripeCheckoutSuccessUrl],
    ['STRIPE_CHECKOUT_CANCEL_URL', config.stripeCheckoutCancelUrl],
    ['STRIPE_PORTAL_RETURN_URL', config.stripePortalReturnUrl]
  ];

  for (const [name, value] of required) {
    if (!String(value || '').trim()) missing.push(`${name} is required`);
  }

  if (config.encryptionKey === 'local-development-key-change-me') {
    missing.push('SERVICE_ENCRYPTION_KEY must not use the development default');
  }

  for (const [name, value] of [
    ['STRIPE_CHECKOUT_SUCCESS_URL', config.stripeCheckoutSuccessUrl],
    ['STRIPE_CHECKOUT_CANCEL_URL', config.stripeCheckoutCancelUrl],
    ['STRIPE_PORTAL_RETURN_URL', config.stripePortalReturnUrl]
  ]) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:') missing.push(`${name} must use HTTPS`);
    } catch (error) {
      missing.push(`${name} must be a valid URL`);
    }
  }

  return missing;
}

module.exports = {
  createConfig,
  validateProductionConfig
};
