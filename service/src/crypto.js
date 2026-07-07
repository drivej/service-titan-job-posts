'use strict';

const crypto = require('crypto');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeLicenseKey(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function licenseHash(value) {
  return sha256Hex(normalizeLicenseKey(value));
}

function randomSecret(prefix, bytes = 32) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

function keyFromSecret(secret) {
  const value = String(secret || '');
  if (!value) throw new Error('SERVICE_ENCRYPTION_KEY is required');

  if (/^[a-f0-9]{64}$/i.test(value)) {
    return Buffer.from(value, 'hex');
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 32) {
    return decoded;
  }

  return crypto.createHash('sha256').update(value).digest();
}

function encryptText(plaintext, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: tag.toString('base64url')
  };
}

function decryptText(envelope, secret) {
  if (!envelope || envelope.alg !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted secret envelope');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyFromSecret(secret),
    Buffer.from(envelope.iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function timingSafeEqualString(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeSiteOrigin(siteUrl) {
  const parsed = new URL(String(siteUrl || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('site_url must be http or https');
  }

  parsed.username = '';
  parsed.password = '';
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';

  return parsed.origin.toLowerCase();
}

function hmacSha256Hex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

module.exports = {
  decryptText,
  encryptText,
  hmacSha256Hex,
  keyFromSecret,
  licenseHash,
  normalizeLicenseKey,
  normalizeSiteOrigin,
  randomSecret,
  sha256Hex,
  timingSafeEqualString
};
