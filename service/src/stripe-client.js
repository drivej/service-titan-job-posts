'use strict';

const { serviceError } = require('./errors');

function appendFormValue(params, key, value) {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => appendFormValue(params, `${key}[${index}]`, item));
    return;
  }

  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      appendFormValue(params, `${key}[${childKey}]`, childValue);
    }
    return;
  }

  params.append(key, String(value));
}

function formEncode(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    appendFormValue(params, key, value);
  }
  return params.toString();
}

class StripeApiClient {
  constructor(config = {}) {
    this.secretKey = config.secretKey || '';
    this.baseUrl = config.baseUrl || 'https://api.stripe.com';
  }

  async request(path, values) {
    if (!this.secretKey) {
      throw serviceError(500, 'stripe_not_configured', 'Stripe secret key is not configured.');
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formEncode(values)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw serviceError(
        response.status,
        'stripe_api_error',
        payload && payload.error && payload.error.message
          ? payload.error.message
          : `Stripe returned HTTP ${response.status}.`
      );
    }
    return payload;
  }

  createCustomer(values) {
    return this.request('/v1/customers', values);
  }

  createCheckoutSession(values) {
    return this.request('/v1/checkout/sessions', values);
  }

  createPortalSession(values) {
    return this.request('/v1/billing_portal/sessions', values);
  }
}

module.exports = {
  StripeApiClient,
  appendFormValue,
  formEncode
};
