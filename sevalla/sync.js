// process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// sevalla/sync.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true }); // For local dev

const WP_URL = process.env.WP_URL?.replace(/\/+$/, ''); // e.g., https://yoursite.com
const WP_USER = process.env.WP_USER;
const WP_APP_PASS = process.env.WP_APP_PASS;

function getJobSlug(job) {
  const identity = job.id ?? job.number;

  if (identity === undefined || identity === null || identity === '') {
    throw new Error('ServiceTitan job is missing both id and number');
  }

  return `st-job-${String(identity).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

async function findExistingJob(job, slug, headers) {
  const endpoint = `${WP_URL}/wp-json/wp/v2/st-jobs`;
  const bySlug = await axios.get(endpoint, {
    params: { slug, context: 'edit', per_page: 1 },
    headers
  });

  if (bySlug.data.length > 0) {
    return bySlug.data[0];
  }

  // Find posts created by older versions, before stable slugs/IDs were stored.
  const legacyMatches = await axios.get(endpoint, {
    params: { search: job.number, context: 'edit', per_page: 100 },
    headers
  });
  const expectedTitlePrefix = `Job #${job.number} -`;

  return legacyMatches.data.find((post) =>
    (job.id !== undefined && String(post.meta?.st_job_id) === String(job.id)) ||
    String(post.meta?.st_job_number) === String(job.number) ||
    (post.title?.raw || post.title?.rendered || '').startsWith(expectedTitlePrefix)
  );
}

async function syncJobs() {
  try {
    if (!WP_URL) {
      throw new Error('WP_URL is not configured');
    }

    // 1. Fetch settings from your WP Plugin API
    const wpAuth = WP_USER && WP_APP_PASS ? Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString('base64') : null;
    if (!wpAuth) {
      throw new Error('WP_USER and WP_APP_PASS are required to sync posts');
    }
    const wpHeaders = { Authorization: `Basic ${wpAuth}` };
    const settingsResp = await axios.get(`${WP_URL}/wp-json/st-sync/v1/settings`, {
      headers: wpHeaders
    });
    const { min_price, jobs_since, client_id, client_secret, tenant_id } = settingsResp.data;
    let jobsResp;

    // 2. DEV STUB LOGIC
    if (process.env.DEV_MODE === 'true') {
      console.log('--- RUNNING IN DEV MODE (USING STUB) ---');
      const rawData = fs.readFileSync(path.join(__dirname, 'mock-jobs.json'));
      jobsResp = { data: JSON.parse(rawData) };
    } else {
      // Live ServiceTitan API Call logic here...

      // 2. Get ServiceTitan Access Token (OAuth2 Client Credentials)
      const tokenResp = await axios.post('https://servicetitan.io', `grant_type=client_credentials&client_id=${client_id}&client_secret=${client_secret}`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const accessToken = tokenResp.data.access_token;

      // 3. Pull Jobs from ServiceTitan filtered by date
      jobsResp = await axios.get(`https://servicetitan.io{tenant_id}/jobs`, {
        params: { createdOnOrAfter: jobs_since },
        headers: { Authorization: `Bearer ${accessToken}`, 'ST-App-Key': process.env.ST_APP_KEY }
      });
    }

    // 4. Filter by Price and Sync to WP
    for (const job of jobsResp.data.data) {
      if (job.totalAmount >= parseFloat(min_price)) {
        const slug = getJobSlug(job);
        const existingPost = await findExistingJob(job, slug, wpHeaders);
        const endpoint = existingPost
          ? `${WP_URL}/wp-json/wp/v2/st-jobs/${existingPost.id}`
          : `${WP_URL}/wp-json/wp/v2/st-jobs`;

        await axios.post(
          endpoint,
          {
            title: `Job #${job.number} - ${job.customer.name}`,
            slug,
            status: 'publish',
            meta: {
              st_job_id: String(job.id ?? ''),
              st_job_number: String(job.number),
              st_job_price: job.totalAmount,
              st_job_date: job.completedOn
            }
          },
          { headers: wpHeaders }
        );
        console.log(`${existingPost ? 'Updated' : 'Created'} Job ${job.number}`);
      }
    }
  } catch (err) {
    if (err.response) {
      console.error(`Sync failed: HTTP ${err.response.status} ${err.config?.method?.toUpperCase()} ${err.config?.url}`, err.response.data);
    } else {
      console.error(`Sync failed${err.code ? ` (${err.code})` : ''}: ${err.message || 'Unknown error'}`);
    }
    process.exitCode = 1;
  }
}

syncJobs();
