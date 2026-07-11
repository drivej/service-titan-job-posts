'use strict';

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES = 1000;

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromSlug(value) {
  return String(value || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseList(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseServiceMappings(value) {
  const mappings = new Map();

  for (const line of String(value || '').split(/\n+/)) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const source = line.slice(0, separator).trim().toLowerCase();
    const target = slugify(line.slice(separator + 1));
    if (source && target) mappings.set(source, target);
  }

  return mappings;
}

function decodeBasicEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function cleanText(value) {
  return decodeBasicEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addressStreetAliases(value) {
  const street = cleanText(value);
  if (!street) return [];

  const aliases = new Set([street]);
  const suffixes = [
    ['Street', 'St'],
    ['Avenue', 'Ave'],
    ['Road', 'Rd'],
    ['Drive', 'Dr'],
    ['Lane', 'Ln'],
    ['Boulevard', 'Blvd'],
    ['Court', 'Ct'],
    ['Circle', 'Cir'],
    ['Place', 'Pl'],
    ['Terrace', 'Ter'],
    ['Parkway', 'Pkwy'],
    ['Highway', 'Hwy']
  ];

  for (const [longSuffix, shortSuffix] of suffixes) {
    const longPattern = new RegExp(`\\b${longSuffix}\\b`, 'i');
    if (longPattern.test(street)) {
      const shortAlias = street.replace(longPattern, shortSuffix);
      aliases.add(shortAlias);
      aliases.add(`${shortAlias}.`);
    }

    const shortPattern = new RegExp(`\\b${shortSuffix}\\.?\\b`, 'i');
    if (shortPattern.test(street)) {
      aliases.add(street.replace(shortPattern, longSuffix));
    }
  }

  return [...aliases];
}

function unitAliases(value) {
  const unit = cleanText(value);
  if (!unit) return [];

  const aliases = new Set([unit]);
  const match = unit.match(/^(?:unit|apt|apartment|suite|ste)\s*#?\s*(.+)$/i);
  if (match && match[1]) {
    const number = match[1].trim();
    for (const prefix of ['Unit', 'Apt', 'Apartment', 'Suite', 'Ste']) {
      aliases.add(`${prefix} ${number}`);
      aliases.add(`${prefix} #${number}`);
    }
    aliases.add(`#${number}`);
  }

  return [...aliases];
}

function redactSensitiveDetails(value, location = {}) {
  let text = cleanText(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[contact removed]')
    .replace(/\b(?:https?:\/\/|www\.)\S+\b/gi, '[link removed]')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone removed]')
    .replace(/\b(?:customer|homeowner|client)\s*:\s*[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,2}\b/g, 'customer');

  const address = location.address || {};
  const exactValues = [
    location.name,
    ...addressStreetAliases(address.street),
    ...unitAliases(address.unit),
    address.zip
  ]
    .map((item) => cleanText(item))
    .filter((item) => item.length >= 3)
    .sort((a, b) => b.length - a.length);

  for (const sensitiveValue of exactValues) {
    text = text.replace(new RegExp(escapeRegExp(sensitiveValue), 'gi'), '[private detail removed]');
  }

  return text
    .replace(/(?:\[(?:contact|link|phone|private detail) removed\]\s*){2,}/gi, '[private detail removed] ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function completionDescription(job, settings = {}) {
  const summaryOfWork = cleanText(job.summaryOfWork);
  if (summaryOfWork) return summaryOfWork;

  const configured = cleanText(settings.completion_custom_field).toLowerCase();
  if (!configured || !Array.isArray(job.customFields)) return '';

  const field = job.customFields.find((candidate) =>
    String(candidate.typeId || '').toLowerCase() === configured ||
    cleanText(candidate.name).toLowerCase() === configured
  );
  return field ? cleanText(field.value) : '';
}

function countWords(value) {
  const matches = cleanText(value).match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu);
  return matches ? matches.length : 0;
}

function countPublicWords(value) {
  return countWords(
    cleanText(value).replace(/\[(?:contact|link|phone|private detail) removed\]/gi, ' ')
  );
}

function locationLabel(location = {}) {
  const address = location.address || {};
  return [cleanText(address.city), cleanText(address.state)].filter(Boolean).join(', ');
}

function sentence(value) {
  const text = cleanText(value);
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function resolveService(jobType, settings) {
  const name = cleanText(jobType.name);
  const jobClass = cleanText(jobType.class);
  const mappings = parseServiceMappings(settings.service_mappings);
  const mapped =
    mappings.get(String(jobType.id || '').toLowerCase()) ||
    mappings.get(name.toLowerCase()) ||
    mappings.get(jobClass.toLowerCase());

  if (mapped) {
    return { slug: mapped, name: titleFromSlug(mapped) };
  }

  const searchable = `${name} ${jobClass}`.toLowerCase();
  const knownServices = [
    { pattern: /\b(plumb|drain|sewer|water heater)\w*/, slug: 'plumbing', name: 'Plumbing' },
    { pattern: /\b(hvac|heating|cooling|furnace|air conditioning|heat pump)\b/, slug: 'hvac', name: 'HVAC' },
    { pattern: /\b(electric|electrical|wiring|panel|generator)\w*/, slug: 'electrical', name: 'Electrical' }
  ];
  const known = knownServices.find((service) => service.pattern.test(searchable));

  if (known) return { slug: known.slug, name: known.name };

  const fallback = slugify(settings.default_service_slug);
  return fallback ? { slug: fallback, name: titleFromSlug(fallback) } : null;
}

function shouldImportJob(job, jobType, location, settings) {
  if (job.jobStatus !== 'Completed' || !job.completedOn) {
    return { accepted: false, reason: 'not-completed' };
  }

  if (!jobType || !jobType.id) {
    return { accepted: false, reason: 'missing-job-type' };
  }

  const total = Number(job.total);
  if (!Number.isFinite(total)) {
    return { accepted: false, reason: 'invalid-total' };
  }

  const minimum = Number.parseFloat(settings.min_price || 0);
  if (total < (Number.isFinite(minimum) ? minimum : 0)) {
    return { accepted: false, reason: 'below-minimum-total' };
  }

  const city = cleanText(location.address && location.address.city);
  if (!city) {
    return { accepted: false, reason: 'missing-city' };
  }

  const allowedCities = new Set(parseList(settings.allowed_cities).map((item) => item.toLowerCase()));
  if (allowedCities.size > 0 && !allowedCities.has(city.toLowerCase())) {
    return { accepted: false, reason: 'city-not-allowed' };
  }

  const excludedTypes = new Set(parseList(settings.excluded_job_types).map((item) => item.toLowerCase()));
  if (excludedTypes.has(cleanText(jobType.name).toLowerCase())) {
    return { accepted: false, reason: 'job-type-excluded' };
  }

  if (!resolveService(jobType, settings)) {
    return { accepted: false, reason: 'unmapped-service' };
  }

  const source = completionDescription(job, settings);
  if (!source) {
    return { accepted: false, reason: 'missing-completion-detail' };
  }

  const minimumWords = Math.max(0, Number.parseInt(settings.min_summary_words || 0, 10) || 0);
  if (countWords(source) < minimumWords) {
    return { accepted: false, reason: 'insufficient-description' };
  }
  if (countPublicWords(redactSensitiveDetails(source, location)) < minimumWords) {
    return { accepted: false, reason: 'insufficient-public-description' };
  }

  return { accepted: true, reason: 'accepted' };
}

function buildSummary(job, jobType, location, settings = {}) {
  const place = locationLabel(location);
  const typeName = cleanText(jobType && jobType.name) || 'Service';
  const work = sentence(redactSensitiveDetails(completionDescription(job, settings), location));

  const introduction = place
    ? `${typeName} job completed for a local customer in ${place}.`
    : `${typeName} job completed for a local customer.`;

  if (!work || work.toLowerCase() === typeName.toLowerCase() || work.toLowerCase() === `${typeName.toLowerCase()}.`) {
    return introduction;
  }

  return `${introduction} ${work}`;
}

function buildJobPayload(job, jobType, location, settings) {
  const city = cleanText(location.address && location.address.city);
  const state = cleanText(location.address && location.address.state);
  const service = resolveService(jobType, settings);
  const summary = buildSummary(job, jobType, location, settings);
  const core = {
    source_tenant_id: String(settings.tenant_id || ''),
    job_id: String(job.id),
    job_number: String(job.jobNumber),
    completed_on: String(job.completedOn),
    total: Number(job.total || 0),
    city,
    state,
    location_slug: slugify(city),
    location_id: String(job.locationId || ''),
    job_type_id: String(job.jobTypeId || ''),
    job_type_name: cleanText(jobType.name),
    service_slug: service.slug,
    service_name: service.name,
    summary
  };

  return {
    ...core,
    sync_hash: crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex')
  };
}

function environmentUrls(environment) {
  const integration = environment === 'integration';
  return {
    auth: integration
      ? 'https://auth-integration.servicetitan.io/connect/token'
      : 'https://auth.servicetitan.io/connect/token',
    api: integration
      ? 'https://api-integration.servicetitan.io'
      : 'https://api.servicetitan.io'
  };
}

function normalizeSinceDate(value) {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date;
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestWithRetry(request, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      const status = error.response && error.response.status;
      const retryable = status === 429 || status >= 500 || !error.response;
      if (!retryable || attempt === attempts) throw error;

      const retryHeader = error.response && error.response.headers['retry-after'];
      const retrySeconds = Number.parseInt(retryHeader, 10);
      const retryDate = retryHeader && !Number.isFinite(retrySeconds) ? Date.parse(retryHeader) : NaN;
      const serverDelay = Number.isFinite(retrySeconds)
        ? retrySeconds * 1000
        : (Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : NaN);
      const exponentialDelay = Math.min(10000, 500 * (2 ** (attempt - 1)));
      const delay = Number.isFinite(serverDelay)
        ? Math.min(30000, serverDelay)
        : Math.round(Math.random() * exponentialDelay);
      await wait(delay);
    }
  }

  throw lastError;
}

async function fetchPaginated(client, endpoint, params = {}) {
  const records = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    if (page > MAX_PAGES) throw new Error(`Pagination safety limit exceeded for ${endpoint}`);

    const response = await requestWithRetry(() => client.get(endpoint, {
      params: {
        ...params,
        page,
        pageSize: params.pageSize || DEFAULT_PAGE_SIZE
      }
    }));
    const body = response.data || {};
    records.push(...(Array.isArray(body.data) ? body.data : []));
    hasMore = body.hasMore === true;
    page += 1;
  }

  return records;
}

function loadDevelopmentData() {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-jobs.json'), 'utf8'));
  return {
    jobs: fixture.jobs && Array.isArray(fixture.jobs.data) ? fixture.jobs.data : [],
    jobTypes: Array.isArray(fixture.jobTypes) ? fixture.jobTypes : [],
    locations: Array.isArray(fixture.locations) ? fixture.locations : []
  };
}

function indexById(items) {
  return new Map(items.map((item) => [String(item.id), item]));
}

async function fetchServiceTitanData(settings, appKey) {
  const required = ['tenant_id', 'client_id', 'client_secret'];
  for (const key of required) {
    if (!settings[key]) throw new Error(`WordPress setting ${key} is required`);
  }
  if (!appKey) throw new Error('ST_APP_KEY is required');

  const urls = environmentUrls(settings.environment);
  const tokenBody = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: settings.client_id,
    client_secret: settings.client_secret
  });
  const tokenResponse = await requestWithRetry(() => axios.post(urls.auth, tokenBody.toString(), {
    timeout: DEFAULT_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }));

  const accessToken = tokenResponse.data && tokenResponse.data.access_token;
  if (!accessToken) throw new Error('ServiceTitan did not return an access token');

  const client = axios.create({
    baseURL: urls.api,
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ST-App-Key': appKey
    }
  });
  const tenant = encodeURIComponent(settings.tenant_id);
  const jobs = await fetchPaginated(client, `/jpm/v2/tenant/${tenant}/jobs`, {
    jobStatus: 'Completed',
    modifiedOnOrAfter: normalizeSinceDate(settings.modified_on_or_after || settings.jobs_since),
    modifiedBefore: normalizeSinceDate(settings.modified_before) || new Date().toISOString(),
    sort: '+ModifiedOn',
    pageSize: DEFAULT_PAGE_SIZE
  });
  const jobTypeIds = [...new Set(jobs.map((job) => String(job.jobTypeId || '')).filter(Boolean))];
  const jobTypes = [];
  for (const ids of chunk(jobTypeIds, 50)) {
    const batch = await fetchPaginated(client, `/jpm/v2/tenant/${tenant}/job-types`, {
      ids: ids.join(','),
      active: 'Any',
      pageSize: 50
    });
    jobTypes.push(...batch);
  }

  const locationIds = [...new Set(jobs.map((job) => String(job.locationId || '')).filter(Boolean))];
  const locations = [];
  for (const ids of chunk(locationIds, 50)) {
    const batch = await fetchPaginated(client, `/crm/v2/tenant/${tenant}/locations`, {
      ids: ids.join(','),
      active: 'Any',
      pageSize: 50
    });
    locations.push(...batch);
  }

  return { jobs, jobTypes, locations };
}

function createWordPressClient(config) {
  const wpUrl = String(config.wpUrl || '').replace(/\/+$/, '');
  if (!wpUrl && !config.deliveryUrl) throw new Error('WP_URL or deliveryUrl is required');

  return axios.create({
    baseURL: wpUrl || undefined,
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

function normalizeHostedServiceUrl(value, config = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error('SERVICE_URL must be a valid URL');
  }

  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';

  const host = parsed.hostname;
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const insecureLocalAllowed = localHost && (
    config.allowInsecureLocalService === true ||
    config.devMode === true ||
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test'
  );
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && insecureLocalAllowed)) {
    throw new Error('SERVICE_URL must use https outside local development');
  }

  return parsed.href.replace(/\/+$/, '');
}

function signDelivery(payload, siteId, signingSecret, now = Math.floor(Date.now() / 1000)) {
  if (!siteId || !signingSecret) {
    throw new Error('SITE_ID and SITE_SIGNING_SECRET are required for delivery');
  }

  const body = JSON.stringify(payload);
  const deliveryId = crypto
    .createHash('sha256')
    .update(`${payload.source_tenant_id}:${payload.job_id}:${payload.sync_hash}`)
    .digest('hex');
  const timestamp = String(now);
  const signature = crypto
    .createHmac('sha256', signingSecret)
    .update(`${timestamp}.${deliveryId}.${body}`)
    .digest('hex');

  return {
    body,
    headers: {
      'X-ST-Site-ID': siteId,
      'X-ST-Timestamp': timestamp,
      'X-ST-Delivery-ID': deliveryId,
      'X-ST-Signature': `v1=${signature}`
    }
  };
}

function settingsFromEnvironment(environment = process.env) {
  return {
    environment: environment.ST_ENVIRONMENT || 'production',
    tenant_id: environment.ST_TENANT_ID || '',
    client_id: environment.ST_CLIENT_ID || '',
    client_secret: environment.ST_CLIENT_SECRET || '',
    min_price: environment.ST_MIN_PRICE || '0',
    jobs_since: environment.ST_JOBS_SINCE || '',
    min_summary_words: environment.ST_MIN_SUMMARY_WORDS || '5',
    completion_custom_field: environment.ST_COMPLETION_CUSTOM_FIELD || '',
    default_service_slug: environment.ST_DEFAULT_SERVICE_SLUG || '',
    service_mappings: environment.ST_SERVICE_MAPPINGS || '',
    allowed_cities: environment.ST_ALLOWED_CITIES || '',
    excluded_job_types: environment.ST_EXCLUDED_JOB_TYPES || ''
  };
}

async function fetchSyncClaims(config = {}) {
  const serviceUrl = normalizeHostedServiceUrl(config.serviceUrl, config);
  const workerApiKey = String(config.workerApiKey || '');
  if (!serviceUrl) throw new Error('SERVICE_URL is required for hosted claim sync');
  if (!workerApiKey) throw new Error('WORKER_API_KEY is required for hosted claim sync');

  const response = await requestWithRetry(() => axios.post(`${serviceUrl}/internal/v1/sync/claims`, {}, {
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${workerApiKey}`,
      'Content-Type': 'application/json'
    }
  }));
  const sites = response.data && response.data.sites;
  return Array.isArray(sites) ? sites : [];
}

function settingsFromClaim(claim) {
  const serviceTitan = claim.service_titan || {};
  return {
    ...(claim.policy || {}),
    modified_on_or_after: claim.modified_on_or_after || '',
    modified_before: claim.modified_before || '',
    environment: serviceTitan.environment || 'production',
    tenant_id: serviceTitan.tenant_id || '',
    client_id: serviceTitan.client_id || '',
    client_secret: serviceTitan.client_secret || ''
  };
}

async function reportSyncRun(config = {}, claim = {}, result = {}, status = 'success', error = null) {
  const body = {
    site_id: claim.site_id,
    claim_id: claim.claim_id || '',
    status,
    processed_until: claim.modified_before || new Date().toISOString(),
    stats: result,
    error: error ? formatError(error) : ''
  };

  if (typeof config.reportRun === 'function') {
    return config.reportRun(body, claim);
  }

  const workerApiKey = String(config.workerApiKey || '');
  if (!config.serviceUrl || !workerApiKey) return null;

  const serviceUrl = normalizeHostedServiceUrl(config.serviceUrl, config);
  if (!serviceUrl || !workerApiKey) return null;

  return requestWithRetry(() => axios.post(`${serviceUrl}/internal/v1/sync/runs`, body, {
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${workerApiKey}`,
      'Content-Type': 'application/json'
    }
  }));
}

async function safeReportSyncRun(config, claim, result, status, error = null) {
  try {
    await reportSyncRun(config, claim, result, status, error);
    return true;
  } catch (reportError) {
    if (!config.quiet) {
      console.error(`Failed to report site ${claim.site_id || 'unknown'} sync run: ${formatError(reportError)}`);
    }
    return false;
  }
}

async function syncJobs(config = {}) {
  const wpClient = config.wpClient || createWordPressClient(config);
  const settings = config.settings || settingsFromEnvironment(config.environment);
  const source = config.source || (
    config.devMode
      ? loadDevelopmentData()
      : await fetchServiceTitanData(settings, config.appKey)
  );
  const jobTypes = indexById(source.jobTypes);
  const locations = indexById(source.locations);
  const results = {
    imported: 0,
    filtered: 0,
    failed: 0,
    reasons: {}
  };

  for (const job of source.jobs) {
    const jobType = jobTypes.get(String(job.jobTypeId)) || {};
    const location = locations.get(String(job.locationId)) || {};
    const decision = shouldImportJob(job, jobType, location, settings);

    if (!decision.accepted) {
      results.filtered += 1;
      results.reasons[decision.reason] = (results.reasons[decision.reason] || 0) + 1;
      continue;
    }

    try {
      const payload = buildJobPayload(job, jobType, location, settings);
      const delivery = config.signDeliveries === false
        ? { body: payload, headers: {} }
        : signDelivery(payload, config.siteId, config.siteSigningSecret);
      const deliveryEndpoint = config.deliveryUrl || '/wp-json/st-sync/v1/jobs';
      const response = await requestWithRetry(() =>
        wpClient.post(deliveryEndpoint, delivery.body, { headers: delivery.headers })
      );
      results.imported += 1;
      if (!config.quiet) {
        const action = response.data && response.data.created ? 'Queued' : 'Updated';
        console.log(`${action} job ${payload.job_number} for ${payload.service_slug}/${payload.location_slug}`);
      }
    } catch (error) {
      results.failed += 1;
      console.error(`Failed job ${job.jobNumber || job.id}: ${formatError(error)}`);
    }
  }

  return results;
}

async function syncClaimedSites(config = {}) {
  const claims = config.claims || await fetchSyncClaims(config);
  const totals = {
    imported: 0,
    filtered: 0,
    failed: 0,
    reasons: {},
    sites: claims.length
  };

  for (const claim of claims) {
    try {
      const result = await syncJobs({
        appKey: config.appKey,
        deliveryUrl: claim.delivery_url,
        devMode: config.devMode,
        quiet: config.quiet,
        settings: settingsFromClaim(claim),
        signDeliveries: config.signDeliveries,
        siteId: claim.site_id,
        siteSigningSecret: claim.signing_secret,
        source: config.source,
        wpClient: config.wpClientFactory ? config.wpClientFactory(claim) : undefined
      });

      totals.imported += result.imported;
      totals.filtered += result.filtered;
      totals.failed += result.failed;
      for (const [reason, count] of Object.entries(result.reasons)) {
        totals.reasons[reason] = (totals.reasons[reason] || 0) + count;
      }
      const status = result.failed > 0 ? 'failed' : 'success';
      const error = result.failed > 0 ? new Error(`${result.failed} job delivery failure(s)`) : null;
      const reported = await safeReportSyncRun(config, claim, result, status, error);
      if (!reported && status === 'success') {
        totals.failed += 1;
      }
    } catch (error) {
      totals.failed += 1;
      await safeReportSyncRun(config, claim, {
        imported: 0,
        filtered: 0,
        failed: 1,
        reasons: {}
      }, 'failed', error);
      if (!config.quiet) {
        console.error(`Failed site ${claim.site_id || 'unknown'}: ${formatError(error)}`);
      }
    }
  }

  return totals;
}

function formatError(error) {
  if (error.response) {
    const method = error.config && error.config.method ? error.config.method.toUpperCase() : 'REQUEST';
    return `HTTP ${error.response.status} ${method} ${error.config && error.config.url}`;
  }
  return error.message || 'Unknown error';
}

async function main() {
  try {
    const hostedMode = Boolean(process.env.SERVICE_URL && process.env.WORKER_API_KEY);
    const standaloneMode = process.env.STANDALONE_SYNC === 'true' || process.env.DEV_MODE === 'true';
    if (!hostedMode && !standaloneMode) {
      throw new Error('SERVICE_URL and WORKER_API_KEY are required. Set STANDALONE_SYNC=true only for isolated development.');
    }

    const results = hostedMode
      ? await syncClaimedSites({
        serviceUrl: process.env.SERVICE_URL,
        workerApiKey: process.env.WORKER_API_KEY,
        appKey: process.env.ST_APP_KEY,
        devMode: process.env.DEV_MODE === 'true'
      })
      : await syncJobs({
        wpUrl: process.env.WP_URL,
        siteId: process.env.SITE_ID,
        siteSigningSecret: process.env.SITE_SIGNING_SECRET,
        appKey: process.env.ST_APP_KEY,
        devMode: process.env.DEV_MODE === 'true',
        settings: settingsFromEnvironment(process.env)
      });
    const siteCount = Number.isFinite(results.sites) ? ` across ${results.sites} eligible site(s)` : '';
    console.log(`Sync complete${siteCount}: ${results.imported} imported, ${results.filtered} filtered, ${results.failed} failed.`);
    if (Object.keys(results.reasons).length > 0) {
      console.log('Filter reasons:', results.reasons);
    }
    if (results.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Sync failed: ${formatError(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildJobPayload,
  buildSummary,
  chunk,
  cleanText,
  completionDescription,
  countWords,
  environmentUrls,
  fetchSyncClaims,
  fetchPaginated,
  formatError,
  main,
  normalizeHostedServiceUrl,
  normalizeSinceDate,
  parseList,
  parseServiceMappings,
  redactSensitiveDetails,
  requestWithRetry,
  resolveService,
  reportSyncRun,
  safeReportSyncRun,
  shouldImportJob,
  signDelivery,
  slugify,
  settingsFromClaim,
  syncClaimedSites,
  syncJobs,
  settingsFromEnvironment
};
