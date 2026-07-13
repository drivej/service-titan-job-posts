'use strict';

const ELIGIBLE_STATUSES = new Set(['active', 'trialing']);

function toIso(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value * 1000).toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function planFromPrice(priceId, priceMap = {}) {
  if (!priceId) return '';
  if (priceMap.monthly && priceId === priceMap.monthly) return 'monthly';
  if (priceMap.yearly && priceId === priceMap.yearly) return 'yearly';
  return 'custom';
}

function isEligibleSubscription(subscription, now = new Date()) {
  if (!subscription || !ELIGIBLE_STATUSES.has(String(subscription.status || ''))) {
    return false;
  }

  const end = Date.parse(toIso(subscription.current_period_end));
  return Number.isFinite(end) && end > now.getTime();
}

function buildEntitlement(subscription, priceMap = {}, now = new Date()) {
  const plan = planFromPrice(subscription && subscription.price_id, priceMap);
  const configuredPrices = [priceMap.monthly, priceMap.yearly].filter(Boolean);
  const recognizedPrice = configuredPrices.length === 0 || ['monthly', 'yearly'].includes(plan);
  return {
    eligible: recognizedPrice && isEligibleSubscription(subscription, now),
    status: String(subscription && subscription.status ? subscription.status : 'none'),
    plan,
    current_period_end: toIso(subscription && subscription.current_period_end)
  };
}

module.exports = {
  ELIGIBLE_STATUSES,
  buildEntitlement,
  isEligibleSubscription,
  planFromPrice,
  toIso
};
