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

module.exports = {
  createConfig
};
