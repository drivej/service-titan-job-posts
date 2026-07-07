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
    shouldImportJob({ ...job, total: 'not-a-total' }, jobType, location, settings).reason,
    'invalid-total'
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
  const source = 'Customer: Jane Customer at 10 Main Street, Unit 2. Call 973-555-1212 or jane@example.com.';
  const redacted = redactSensitiveDetails(source, location);

  assert.doesNotMatch(redacted, /Jane Customer|10 Main Street|Unit 2|973-555-1212|jane@example.com/i);
  assert.match(redacted, /removed/);
});

test('generated summary and payload are local, descriptive, and omit publication status', () => {
  const summary = buildSummary(job, jobType, location);
  const payload = buildJobPayload(job, jobType, location, settings);

  assert.match(summary, /^Drain Cleaning service was completed for a customer in Newark\./);
  assert.match(summary, /hydro-jet/);
  assert.equal(payload.service_slug, 'plumbing');
  assert.equal(payload.source_tenant_id, 'tenant-123');
  assert.equal(payload.location_slug, 'newark');
  assert.equal(payload.job_number, 'JOB-123');
  assert.equal(payload.sync_hash.length, 64);
  assert.equal(Object.hasOwn(payload, 'status'), false);
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

test('hosted claim sync reports successful run windows without requiring HTTP in injected-claim tests', async () => {
  const claim = {
    site_id: 'site_reported',
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
  assert.equal(reports[0][0].status, 'success');
  assert.equal(reports[0][0].processed_until, claim.modified_before);
  assert.equal(reports[0][0].stats.imported, 1);
});

test('hosted claim sync isolates one site failure from other eligible sites', async () => {
  const goodClaim = {
    site_id: 'site_good',
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
    claims: [{ site_id: 'site_bad' }, goodClaim],
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
});
