'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildJobPayload,
  buildSummary,
  completionDescription,
  environmentUrls,
  fetchPaginated,
  normalizeHostedServiceUrl,
  normalizeZipCode,
  parseServiceMappings,
  redactSensitiveDetails,
  resolveService,
  settingsFromClaim,
  signDelivery,
  shouldImportJob,
  slugify,
  syncClaimedSites,
  syncJobs
} = require('../sync');

const settings = {
  tenant_id: 'tenant-123',
  min_price: '100',
  min_summary_words: '4',
  allowed_cities: 'Newark, Montclair',
  excluded_job_types: 'Estimate',
  default_service_slug: 'home-services',
  completion_custom_field: '',
  service_mappings: '201=plumbing'
};

const job = {
  id: 1001,
  jobNumber: 'JOB-123',
  locationId: 501,
  jobTypeId: 201,
  jobStatus: 'Completed',
  completedOn: '2026-07-02T14:30:00Z',
  total: 750,
  summaryOfWork: 'Cleared a sewage backup and removed the clog with a hydro-jet.'
};

const jobType = {
  id: 201,
  name: 'Drain Cleaning',
  class: 'Plumbing',
  summary: ''
};

const location = {
  id: 501,
  name: 'Jane Customer',
  address: {
    street: '10 Main Street',
    unit: 'Unit 2',
    city: 'Newark',
    state: 'NJ',
    zip: '07102'
  }
};

test('slugify creates URL-safe location and service values', () => {
  assert.equal(slugify(' Air Conditioning & Heating '), 'air-conditioning-heating');
  assert.equal(slugify('São José'), 'sao-jose');
});

test('ZIP codes normalize to a canonical five-digit routing value', () => {
  assert.equal(normalizeZipCode('07102'), '07102');
  assert.equal(normalizeZipCode(' 90723-1234 '), '90723');
  assert.equal(normalizeZipCode('7102'), '');
  assert.equal(normalizeZipCode('90723 1234'), '');
  assert.equal(normalizeZipCode(null), '');
});

test('service mappings override automatic classification', () => {
  const mappings = parseServiceMappings(settings.service_mappings);
  assert.equal(mappings.get('201'), 'plumbing');
  assert.deepEqual(resolveService(jobType, settings), {
    slug: 'plumbing',
    name: 'Plumbing'
  });
});

test('known trade terms classify without a custom mapping', () => {
  assert.deepEqual(resolveService({ name: 'Furnace Repair', class: '' }, {
    ...settings,
    service_mappings: ''
  }), {
    slug: 'hvac',
    name: 'HVAC'
  });
});

test('job filtering requires completion, a qualifying total, city, and useful source content', () => {
  assert.deepEqual(shouldImportJob(job, jobType, location, settings), {
    accepted: true,
    reason: 'accepted'
  });
  assert.equal(
    shouldImportJob({ ...job, jobStatus: 'Scheduled' }, jobType, location, settings).reason,
    'not-completed'
  );
  assert.equal(
    shouldImportJob({ ...job, total: 50 }, jobType, location, settings).reason,
    'below-minimum-total'
  );
  assert.equal(
    shouldImportJob(job, jobType, { ...location, address: { city: 'Trenton' } }, settings).reason,
    'city-not-allowed'
  );
  assert.equal(
    shouldImportJob({ ...job, summaryOfWork: 'Fixed it' }, jobType, location, settings).reason,
    'insufficient-description'
  );
  assert.equal(
    shouldImportJob({
      ...job,
      summaryOfWork: 'Jane Customer 10 Main St Unit #2 9735551212 jane@example.com'
    }, jobType, location, settings).reason,
    'insufficient-public-description'
  );
  assert.equal(
    shouldImportJob({ ...job, total: 'not-a-total' }, jobType, location, settings).reason,
    'invalid-total'
  );
  assert.equal(
    shouldImportJob({ ...job, completedOn: 'not-a-date' }, jobType, location, settings).reason,
    'invalid-completion-date'
  );
  assert.equal(
    shouldImportJob(job, {}, location, settings).reason,
    'missing-job-type'
  );
});

test('only verified completion fields can become job copy', () => {
  const noCompletion = {
    ...job,
    summaryOfWork: '',
    summary: 'Customer reported a drain backup when booking.'
  };
  assert.equal(completionDescription(noCompletion, settings), '');
  assert.equal(
    shouldImportJob(noCompletion, jobType, location, settings).reason,
    'missing-completion-detail'
  );

  const withCustomField = {
    ...noCompletion,
    customFields: [
      { typeId: 765, name: 'Technician Closeout', value: 'Hydro-jetted the main line and verified flow.' }
    ]
  };
  const customSettings = { ...settings, completion_custom_field: '765' };
  assert.equal(
    completionDescription(withCustomField, customSettings),
    'Hydro-jetted the main line and verified flow.'
  );
  assert.equal(
    shouldImportJob(withCustomField, jobType, location, customSettings).accepted,
    true
  );
});

test('unknown trades are quarantined unless an explicit fallback is configured', () => {
  const unknownType = { id: 999, name: 'General Visit', class: 'Other' };
  const noFallback = {
    ...settings,
    service_mappings: '',
    default_service_slug: ''
  };

  assert.equal(resolveService(unknownType, noFallback), null);
  assert.equal(
    shouldImportJob(job, unknownType, location, noFallback).reason,
    'unmapped-service'
  );
});

test('summary removes known private contact and address details', () => {
  const source = 'Jane Customer said the issue returned at 10 Main St., Unit #2. Call 9735551212 or jane@example.com.';
  const redacted = redactSensitiveDetails(source, location);

  assert.doesNotMatch(redacted, /Jane Customer|10 Main St|Unit #2|9735551212|jane@example.com/i);
  assert.match(redacted, /removed/);

  const expandedLocation = {
    ...location,
    name: 'Smith, John'
  };
  const sensitive = redactSensitiveDetails(
    'John Smith requested entry using lockbox code 2468 at 22 Oak Avenue. SSN 123-45-6789.',
    expandedLocation
  );
  assert.doesNotMatch(sensitive, /John Smith|2468|22 Oak|123-45-6789/i);
  assert.match(sensitive, /access code removed/);
});

test('generated summary and payload are local, descriptive, and omit publication status', () => {
  const summary = buildSummary(job, jobType, location);
  const unpunctuated = buildSummary({
    ...job,
    summaryOfWork: 'Restored drainage and verified normal flow'
  }, jobType, location);
  const privateDetailSummary = buildSummary({
    ...job,
    summaryOfWork: 'Jane Customer reported trouble at 10 Main St Unit #2. Cleared the sewer line.'
  }, jobType, location);
  const payload = buildJobPayload(job, jobType, location, settings);
  const offsetPayload = buildJobPayload({
    ...job,
    completedOn: '2026-07-02T10:30:00-04:00'
  }, jobType, location, settings);

  assert.match(summary, /^Drain Cleaning job completed for a local customer in Newark, NJ\./);
  assert.match(summary, /hydro-jet/);
  assert.match(unpunctuated, /Restored drainage and verified normal flow\.$/);
  assert.doesNotMatch(privateDetailSummary, /Jane Customer|10 Main|Unit #2/i);
  assert.match(privateDetailSummary, /Cleared the sewer line\./);
  assert.equal(payload.service_slug, 'plumbing');
  assert.equal(payload.source_tenant_id, 'tenant-123');
  assert.equal(payload.location_slug, 'newark');
  assert.equal(payload.zip_code, '07102');
  assert.equal(payload.job_number, 'JOB-123');
  assert.equal(payload.completed_on, '2026-07-02T14:30:00.000Z');
  assert.equal(offsetPayload.completed_on, '2026-07-02T14:30:00.000Z');
  assert.equal(payload.sync_hash.length, 64);
  assert.equal(payload.legacy_sync_hash.length, 64);
  assert.notEqual(payload.sync_hash, payload.legacy_sync_hash);
  assert.equal(Object.hasOwn(payload, 'status'), false);
});

test('ZIP changes affect the current hash while preserving the legacy content hash', () => {
  const original = buildJobPayload(job, jobType, location, settings);
  const changed = buildJobPayload(job, jobType, {
    ...location,
    address: { ...location.address, zip: '07001-4321' }
  }, settings);
  const missing = buildJobPayload(job, jobType, {
    ...location,
    address: { ...location.address, zip: '' }
  }, settings);
  const malformed = buildJobPayload(job, jobType, {
    ...location,
    address: { ...location.address, zip: 'not-a-zip' }
  }, settings);

  assert.equal(changed.zip_code, '07001');
  assert.notEqual(changed.sync_hash, original.sync_hash);
  assert.equal(changed.legacy_sync_hash, original.legacy_sync_hash);
  assert.equal(Object.hasOwn(missing, 'zip_code'), false);
  assert.equal(missing.sync_hash, missing.legacy_sync_hash);
  assert.equal(Object.hasOwn(malformed, 'zip_code'), false);
  assert.equal(malformed.sync_hash, malformed.legacy_sync_hash);
});

test('delivery signature binds the site, timestamp, delivery ID, and exact body', () => {
  const payload = buildJobPayload(job, jobType, location, settings);
  const delivery = signDelivery(payload, 'site-123', 'test-secret', 1720000000);
  const deliveryId = delivery.headers['X-ST-Delivery-ID'];
  const expected = require('node:crypto')
    .createHmac('sha256', 'test-secret')
    .update(`1720000000.${deliveryId}.${delivery.body}`)
    .digest('hex');

  assert.equal(delivery.headers['X-ST-Site-ID'], 'site-123');
  assert.equal(delivery.headers['X-ST-Signature'], `v1=${expected}`);
});

test('production and integration ServiceTitan hosts stay isolated', () => {
  assert.deepEqual(environmentUrls('production'), {
    auth: 'https://auth.servicetitan.io/connect/token',
    api: 'https://api.servicetitan.io'
  });
  assert.deepEqual(environmentUrls('integration'), {
    auth: 'https://auth-integration.servicetitan.io/connect/token',
    api: 'https://api-integration.servicetitan.io'
  });
});

test('hosted service claim URL must use HTTPS outside local development', () => {
  assert.equal(
    normalizeHostedServiceUrl('https://service.example.com/base/'),
    'https://service.example.com/base'
  );
  assert.equal(
    normalizeHostedServiceUrl('http://localhost:8080/', { allowInsecureLocalService: true }),
    'http://localhost:8080'
  );
  assert.throws(
    () => normalizeHostedServiceUrl('http://service.example.com'),
    /https/
  );
});

test('pagination follows hasMore and combines all pages', async () => {
  const requestedPages = [];
  const client = {
    async get(endpoint, options) {
      requestedPages.push([endpoint, options.params.page]);
      return {
        data: {
          data: [{ id: options.params.page }],
          hasMore: options.params.page < 3
        }
      };
    }
  };

  const records = await fetchPaginated(client, '/jobs', { pageSize: 50 });
  assert.deepEqual(records, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(requestedPages, [
    ['/jobs', 1],
    ['/jobs', 2],
    ['/jobs', 3]
  ]);
});

test('sync queues accepted jobs through the authenticated custom endpoint and reports filters', async () => {
  const posted = [];
  const wpClient = {
    async post(endpoint, payload) {
      posted.push([endpoint, payload]);
      return { data: { created: true, status: 'pending' } };
    }
  };
  const source = {
    jobs: [job, { ...job, id: 1002, jobNumber: 'JOB-124', total: 50 }],
    jobTypes: [jobType],
    locations: [location]
  };

  const result = await syncJobs({
    wpClient,
    source,
    settings,
    quiet: true,
    signDeliveries: false
  });
  assert.deepEqual(result, {
    imported: 1,
    filtered: 1,
    failed: 0,
    reasons: { 'below-minimum-total': 1 }
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0][0], '/wp-json/st-sync/v1/jobs');
  assert.equal(posted[0][1].job_id, '1001');
});

test('hosted claim sync uses service-issued entitlement, credentials, policy, and delivery URL', async () => {
  const claim = {
    site_id: 'site_123',
    delivery_url: 'https://client.example/wp-json/st-sync/v1/jobs',
    signing_secret: 'site-secret',
    policy: {
      min_price: '100',
      min_summary_words: '4',
      allowed_cities: 'Newark',
      service_mappings: '201=plumbing'
    },
    modified_on_or_after: '2026-07-01T00:00:00.000Z',
    modified_before: '2026-07-07T12:00:00.000Z',
    service_titan: {
      tenant_id: 'tenant-from-service',
      environment: 'integration',
      client_id: 'encrypted-at-rest-client-id',
      client_secret: 'encrypted-at-rest-client-secret'
    }
  };
  const posted = [];
  const source = {
    jobs: [job],
    jobTypes: [jobType],
    locations: [location]
  };

  const result = await syncClaimedSites({
    claims: [claim],
    source,
    quiet: true,
    wpClientFactory() {
      return {
        async post(endpoint, payload, options) {
          posted.push([endpoint, payload, options.headers]);
          return { data: { created: true, status: 'pending' } };
        }
      };
    }
  });

  assert.deepEqual(settingsFromClaim(claim), {
    ...claim.policy,
    modified_on_or_after: '2026-07-01T00:00:00.000Z',
    modified_before: '2026-07-07T12:00:00.000Z',
    environment: 'integration',
    tenant_id: 'tenant-from-service',
    client_id: 'encrypted-at-rest-client-id',
    client_secret: 'encrypted-at-rest-client-secret'
  });
  assert.equal(result.imported, 1);
  assert.equal(result.sites, 1);
  assert.equal(posted[0][0], 'https://client.example/wp-json/st-sync/v1/jobs');
  assert.equal(JSON.parse(posted[0][1]).source_tenant_id, 'tenant-from-service');
  assert.equal(posted[0][2]['X-ST-Site-ID'], 'site_123');
  assert.match(posted[0][2]['X-ST-Signature'], /^v1=[a-f0-9]{64}$/);
});

test('hosted claim sync rechecks entitlement immediately before WordPress delivery', async () => {
  const claim = {
    site_id: 'site_canceled_mid_run',
    claim_id: 'claim_canceled_mid_run',
    delivery_url: 'https://client.example/wp-json/st-sync/v1/jobs',
    signing_secret: 'site-secret',
    policy: settings,
    service_titan: {
      tenant_id: 'tenant-123',
      environment: 'production',
      client_id: 'client',
      client_secret: 'secret'
    }
  };
  const posted = [];
  const reports = [];

  const result = await syncClaimedSites({
    claims: [claim],
    source: { jobs: [job], jobTypes: [jobType], locations: [location] },
    quiet: true,
    authorizeClaim(receivedClaim) {
      assert.equal(receivedClaim.claim_id, claim.claim_id);
      return false;
    },
    reportRun(body) {
      reports.push(body);
    },
    wpClientFactory() {
      return {
        async post(...args) {
          posted.push(args);
          return { data: { created: true } };
        }
      };
    }
  });

  assert.equal(result.imported, 0);
  assert.equal(result.failed, 1);
  assert.equal(posted.length, 0);
  assert.equal(reports[0].status, 'failed');
  assert.match(reports[0].error, /denied delivery authorization/);
});

test('hosted claim sync reports successful run windows without requiring HTTP in injected-claim tests', async () => {
  const claim = {
    site_id: 'site_reported',
    claim_id: 'claim_reported',
    delivery_url: 'https://client.example/wp-json/st-sync/v1/jobs',
    signing_secret: 'site-secret',
    policy: settings,
    modified_before: '2026-07-07T12:00:00.000Z',
    service_titan: {
      tenant_id: 'tenant-123',
      environment: 'production',
      client_id: 'client',
      client_secret: 'secret'
    }
  };
  const reports = [];

  const result = await syncClaimedSites({
    claims: [claim],
    source: {
      jobs: [job],
      jobTypes: [jobType],
      locations: [location]
    },
    quiet: true,
    reportRun(body, reportedClaim) {
      reports.push([body, reportedClaim.site_id]);
    },
    wpClientFactory() {
      return {
        async post() {
          return { data: { created: true } };
        }
      };
    }
  });

  assert.equal(result.imported, 1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1], 'site_reported');
  assert.equal(reports[0][0].claim_id, 'claim_reported');
  assert.equal(reports[0][0].status, 'success');
  assert.equal(reports[0][0].processed_until, claim.modified_before);
  assert.equal(reports[0][0].stats.imported, 1);
});

test('hosted claim sync isolates one site failure from other eligible sites', async () => {
  const goodClaim = {
    site_id: 'site_good',
    claim_id: 'claim_good',
    delivery_url: 'https://client.example/wp-json/st-sync/v1/jobs',
    signing_secret: 'site-secret',
    policy: settings,
    service_titan: {
      tenant_id: 'tenant-123',
      environment: 'production',
      client_id: 'client',
      client_secret: 'secret'
    }
  };
  const source = {
    jobs: [job],
    jobTypes: [jobType],
    locations: [location]
  };
  const posted = [];
  const reports = [];

  const result = await syncClaimedSites({
    claims: [{ site_id: 'site_bad', claim_id: 'claim_bad' }, goodClaim],
    source,
    quiet: true,
    reportRun(body) {
      reports.push(body);
    },
    wpClientFactory(claim) {
      if (claim.site_id === 'site_bad') {
        throw new Error('bad site transport');
      }
      return {
        async post(endpoint, payload) {
          posted.push([endpoint, payload]);
          return { data: { created: true } };
        }
      };
    }
  });

  assert.equal(result.sites, 2);
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.equal(posted.length, 1);
  assert.deepEqual(reports.map((report) => report.status), ['failed', 'success']);
  assert.deepEqual(reports.map((report) => report.claim_id), ['claim_bad', 'claim_good']);
});

test('hosted claim sync drains singleton batches with one stable server run boundary', async () => {
  const runStartedAt = '2026-07-07T12:00:00.000Z';
  const claims = ['site_one', 'site_two'].map((siteId) => ({
    site_id: siteId,
    claim_id: `claim_${siteId}`,
    delivery_url: `https://${siteId}.example/wp-json/st-sync/v1/jobs`,
    signing_secret: 'site-secret',
    policy: settings,
    service_titan: {
      tenant_id: 'tenant-123',
      environment: 'production',
      client_id: 'client',
      client_secret: 'secret'
    }
  }));
  const requestBodies = [];
  const reports = [];

  const result = await syncClaimedSites({
    fetchClaims(body) {
      requestBodies.push(body);
      return {
        sites: requestBodies.length <= claims.length ? [claims[requestBodies.length - 1]] : [],
        run_started_at: runStartedAt
      };
    },
    source: { jobs: [job], jobTypes: [jobType], locations: [location] },
    quiet: true,
    reportRun(body) {
      reports.push(body);
    },
    wpClientFactory() {
      return { async post() { return { data: { created: true } }; } };
    }
  });

  assert.equal(result.sites, 2);
  assert.equal(result.imported, 2);
  assert.equal(result.failed, 0);
  assert.equal(requestBodies.length, 3);
  assert.deepEqual(requestBodies, [
    { limit: 1 },
    { limit: 1, run_started_at: runStartedAt },
    { limit: 1, run_started_at: runStartedAt }
  ]);
  assert.deepEqual(reports.map((report) => report.site_id), ['site_one', 'site_two']);
});

test('hosted claim sync stops claiming when a run report cannot be persisted', async () => {
  let claimRequests = 0;
  const result = await syncClaimedSites({
    fetchClaims() {
      claimRequests += 1;
      return {
        sites: [{
          site_id: 'site_unreported',
          claim_id: 'claim_unreported',
          delivery_url: 'https://client.example/wp-json/st-sync/v1/jobs',
          signing_secret: 'site-secret',
          policy: settings,
          service_titan: { tenant_id: 'tenant', client_id: 'client', client_secret: 'secret' }
        }],
        run_started_at: '2026-07-07T12:00:00.000Z'
      };
    },
    source: { jobs: [job], jobTypes: [jobType], locations: [location] },
    quiet: true,
    reportRun() {
      throw new Error('report unavailable');
    },
    wpClientFactory() {
      return { async post() { return { data: { created: true } }; } };
    }
  });

  assert.equal(claimRequests, 1);
  assert.equal(result.sites, 1);
  assert.equal(result.failed, 1);
});

test('hosted claim sync stops at the configured batch safety bound', async () => {
  let claimRequests = 0;
  const result = await syncClaimedSites({
    maxClaimBatches: 2,
    fetchClaims() {
      claimRequests += 1;
      return {
        sites: [{
          site_id: `site_${claimRequests}`,
          claim_id: `claim_${claimRequests}`,
          delivery_url: 'https://client.example/wp-json/st-sync/v1/jobs',
          signing_secret: 'site-secret',
          policy: settings,
          service_titan: { tenant_id: 'tenant', client_id: 'client', client_secret: 'secret' }
        }],
        run_started_at: '2026-07-07T12:00:00.000Z'
      };
    },
    source: { jobs: [], jobTypes: [], locations: [] },
    quiet: true,
    reportRun() {}
  });

  assert.equal(claimRequests, 2);
  assert.equal(result.sites, 2);
  assert.equal(result.failed, 1);
});

test('hosted claim sync rejects oversized batches and changing run boundaries', async () => {
  await assert.rejects(() => syncClaimedSites({
    quiet: true,
    fetchClaims() {
      return {
        sites: [{ site_id: 'one' }, { site_id: 'two' }],
        run_started_at: '2026-07-07T12:00:00.000Z'
      };
    }
  }), /invalid sync claim batch/);

  let requests = 0;
  await assert.rejects(() => syncClaimedSites({
    quiet: true,
    fetchClaims() {
      requests += 1;
      return {
        sites: requests === 1 ? [{
          site_id: 'site_one',
          claim_id: 'claim_one',
          delivery_url: 'https://client.example/wp-json/st-sync/v1/jobs',
          signing_secret: 'site-secret',
          policy: settings,
          service_titan: { tenant_id: 'tenant', client_id: 'client', client_secret: 'secret' }
        }] : [],
        run_started_at: requests === 1
          ? '2026-07-07T12:00:00.000Z'
          : '2026-07-07T12:01:00.000Z'
      };
    },
    source: { jobs: [], jobTypes: [], locations: [] },
    reportRun() {}
  }), /changed the sync run boundary/);
});
