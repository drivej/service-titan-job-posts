'use strict';

const { hmacSha256Hex, timingSafeEqualString } = require('./crypto');
const { serviceError } = require('./errors');

function parseStripeSignature(header) {
  const parts = {};
  for (const segment of String(header || '').split(',')) {
    const separator = segment.indexOf('=');
    if (separator === -1) continue;
    const key = segment.slice(0, separator);
    const value = segment.slice(separator + 1);
    if (!parts[key]) parts[key] = [];
    parts[key].push(value);
  }
  return parts;
}

function verifyStripeSignature(rawBody, signatureHeader, webhookSecret, options = {}) {
  if (!webhookSecret) {
    throw serviceError(500, 'stripe_not_configured', 'Stripe webhook signing secret is not configured.');
  }

  const toleranceSeconds = options.toleranceSeconds || 300;
  const now = options.now || Math.floor(Date.now() / 1000);
  const parsed = parseStripeSignature(signatureHeader);
  const timestamp = Number.parseInt(parsed.t && parsed.t[0], 10);
  const signatures = parsed.v1 || [];

  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw serviceError(400, 'invalid_stripe_signature', 'Stripe-Signature is missing a timestamp or v1 signature.');
  }

  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw serviceError(400, 'stale_stripe_signature', 'Stripe webhook timestamp is outside the allowed tolerance.');
  }

  const expected = hmacSha256Hex(webhookSecret, `${timestamp}.${rawBody}`);
  if (!signatures.some((signature) => timingSafeEqualString(signature, expected))) {
    throw serviceError(400, 'invalid_stripe_signature', 'Stripe webhook signature verification failed.');
  }

  return true;
}

function stripeSignatureHeader(rawBody, webhookSecret, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacSha256Hex(webhookSecret, `${timestamp}.${rawBody}`)}`;
}

function subscriptionFromStripeObject(object, eventType = '') {
  if (!object || object.object !== 'subscription') return null;

  const firstItem = object.items && Array.isArray(object.items.data) ? object.items.data[0] : null;
  const price = firstItem && firstItem.price ? firstItem.price : {};
  const currentPeriodEnd = object.current_period_end || (firstItem && firstItem.current_period_end) || null;
  const collectionPaused = object.pause_collection !== null && object.pause_collection !== undefined;

  return {
    stripe_subscription_id: object.id,
    stripe_customer_id: typeof object.customer === 'string' ? object.customer : object.customer && object.customer.id,
    account_id: object.metadata && object.metadata.account_id,
    status: eventType === 'customer.subscription.deleted'
      ? 'canceled'
      : (collectionPaused ? 'paused' : object.status),
    price_id: price.id || object.plan && object.plan.id || '',
    current_period_end: currentPeriodEnd || '',
    cancel_at_period_end: object.cancel_at_period_end === true
  };
}

module.exports = {
  parseStripeSignature,
  stripeSignatureHeader,
  subscriptionFromStripeObject,
  verifyStripeSignature
};
