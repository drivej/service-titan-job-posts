'use strict';

const SYNC_CURSOR_OVERLAP_MS = 10 * 60 * 1000;
const SYNC_CLAIM_LEASE_MS = 30 * 60 * 1000;

function dateTime(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeSinceDate(value) {
  const date = String(value || '').trim();
  if (!date) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date;
}

function nowDate(context = {}) {
  return context.now instanceof Date ? context.now : new Date(context.now || Date.now());
}

function syncWindowForSite(site = {}, context = {}) {
  const before = nowDate(context).toISOString();
  let after = '';
  const lastSuccessful = dateTime(site.last_successful_sync_at);

  if (Number.isFinite(lastSuccessful)) {
    after = new Date(Math.max(0, lastSuccessful - SYNC_CURSOR_OVERLAP_MS)).toISOString();
  } else if (site.policy && site.policy.jobs_since) {
    after = normalizeSinceDate(site.policy.jobs_since);
  }

  return {
    modified_on_or_after: after,
    modified_before: before
  };
}

module.exports = {
  SYNC_CLAIM_LEASE_MS,
  SYNC_CURSOR_OVERLAP_MS,
  normalizeSinceDate,
  syncWindowForSite
};
