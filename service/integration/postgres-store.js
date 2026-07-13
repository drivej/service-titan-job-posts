'use strict';

const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { ServiceError } = require('../src/errors');
const { PostgresStore } = require('../src/store/postgres-store');

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');

  const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });
  const store = new PostgresStore(pool);
  const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const accountId = `acct_pg_${token}`;
  const licenseId = `lic_pg_${token}`;
  const siteId = `site_pg_${token}`;
  const initialTime = new Date('2026-07-07T12:00:00.000Z');
  const currentClaim = `claim_current_${token}`;

  try {
    await pool.query(
      'INSERT INTO accounts (id, email, created_at, updated_at) VALUES ($1,$2,$3,$3)',
      [accountId, `${token}@example.test`, initialTime]
    );
    await pool.query(
      `INSERT INTO licenses (id, account_id, key_hash, active, site_limit, created_at, updated_at)
       VALUES ($1,$2,$3,true,1,$4,$4)`,
      [licenseId, accountId, `hash_${token}`, initialTime]
    );

    const subscriptionBase = {
      account_id: accountId,
      stripe_subscription_id: `sub_pg_${token}`,
      stripe_customer_id: `cus_pg_${token}`,
      price_id: 'price_monthly',
      current_period_end: new Date('2026-08-01T00:00:00.000Z'),
      cancel_at_period_end: false,
      stripe_event_created: 1783425600
    };
    const reconciliationOne = await store.nextStripeReconciliationSequence();
    const reconciliationTwo = await store.nextStripeReconciliationSequence();
    const reconciliationThree = await store.nextStripeReconciliationSequence();
    assert.ok(reconciliationOne < reconciliationTwo && reconciliationTwo < reconciliationThree);
    await store.applyStripeSubscription({
      ...subscriptionBase,
      status: 'paused',
      stripe_reconciliation_sequence: reconciliationOne
    }, {});
    await store.applyStripeSubscription({
      ...subscriptionBase,
      status: 'active',
      stripe_reconciliation_sequence: reconciliationTwo
    }, {});
    await store.applyStripeSubscription({
      ...subscriptionBase,
      status: 'active',
      stripe_event_created: 9999999999
    }, {});
    await store.applyStripeSubscription({
      ...subscriptionBase,
      status: 'paused',
      stripe_event_created: subscriptionBase.stripe_event_created - 60,
      stripe_reconciliation_sequence: reconciliationThree
    }, {});
    await store.applyStripeSubscription({
      ...subscriptionBase,
      status: 'active',
      stripe_reconciliation_sequence: reconciliationTwo
    }, {});
    const reconciledSubscription = await pool.query(
      'SELECT status FROM subscriptions WHERE account_id = $1',
      [accountId]
    );
    assert.equal(reconciledSubscription.rows[0].status, 'paused');

    await pool.query(
      `INSERT INTO sites (
         id, account_id, license_id, site_url, installation_id, delivery_url,
         plugin_version, activation_token_hash, signing_secret_encrypted, policy,
         last_successful_sync_at, last_sync_attempt_at, last_sync_status,
         last_sync_error, last_sync_stats, sync_claim_id, sync_claimed_until,
         created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'test',$7,$8::jsonb,'{}'::jsonb,
         $9,$9,'success','',$10::jsonb,$11,$12,$9,$9
       )`,
      [
        siteId,
        accountId,
        licenseId,
        'https://postgres-test.example',
        `install_${token}`,
        'https://postgres-test.example/wp-json/st-sync/v1/jobs',
        `activation_${token}`,
        JSON.stringify({ iv: 'test', tag: 'test', data: 'test' }),
        initialTime,
        JSON.stringify({ imported: 2, filtered: 3, failed: 0 }),
        currentClaim,
        new Date('2026-07-07T12:30:00.000Z')
      ]
    );

    const snapshot = async () => {
      const result = await pool.query(
        `SELECT last_successful_sync_at, last_sync_attempt_at, last_sync_status,
                last_sync_error, last_sync_stats, sync_claim_id,
                sync_claimed_until, updated_at
           FROM sites WHERE id = $1`,
        [siteId]
      );
      const row = result.rows[0];
      return {
        ...row,
        last_successful_sync_at: iso(row.last_successful_sync_at),
        last_sync_attempt_at: iso(row.last_sync_attempt_at),
        sync_claimed_until: iso(row.sync_claimed_until),
        updated_at: iso(row.updated_at)
      };
    };

    const before = await snapshot();
    for (const staleReport of [
      {
        site_id: siteId,
        claim_id: 'claim_stale_success',
        status: 'success',
        processed_until: new Date('2026-07-08T00:00:00.000Z'),
        stats: { imported: 999 },
        error: ''
      },
      {
        site_id: siteId,
        claim_id: 'claim_stale_failure',
        status: 'failed',
        processed_until: null,
        stats: { failed: 999 },
        error: 'stale failure'
      }
    ]) {
      await assert.rejects(
        () => store.recordSyncRun(staleReport, { now: new Date('2026-07-07T12:05:00.000Z') }),
        (error) => error instanceof ServiceError && error.status === 409 && error.code === 'stale_sync_claim'
      );
      assert.deepEqual(await snapshot(), before);
    }

    const valid = await store.recordSyncRun({
      site_id: siteId,
      claim_id: currentClaim,
      status: 'failed',
      processed_until: null,
      stats: { imported: 0, filtered: 0, failed: 1 },
      error: 'current claim failure'
    }, { now: new Date('2026-07-07T12:06:00.000Z') });

    assert.equal(valid.last_sync_status, 'failed');
    const afterValid = await snapshot();
    assert.equal(afterValid.last_successful_sync_at, initialTime.toISOString());
    assert.equal(afterValid.last_sync_status, 'failed');
    assert.equal(afterValid.last_sync_error, 'current claim failure');
    assert.equal(afterValid.sync_claim_id, null);
    assert.equal(afterValid.sync_claimed_until, null);

    const successClaim = `claim_success_${token}`;
    await pool.query(
      `UPDATE sites
          SET sync_claim_id = $2,
              sync_claimed_until = $3
        WHERE id = $1`,
      [siteId, successClaim, new Date('2026-07-07T12:30:00.000Z')]
    );
    const successful = await store.recordSyncRun({
      site_id: siteId,
      claim_id: successClaim,
      status: 'success',
      processed_until: new Date('2026-07-07T12:10:00.000Z'),
      stats: { imported: 4, filtered: 1, failed: 0 },
      error: ''
    }, { now: new Date('2026-07-07T12:11:00.000Z') });

    assert.equal(iso(successful.last_successful_sync_at), '2026-07-07T12:10:00.000Z');
    assert.equal(successful.last_sync_status, 'success');
    const afterSuccess = await snapshot();
    assert.equal(afterSuccess.last_successful_sync_at, '2026-07-07T12:10:00.000Z');
    assert.equal(afterSuccess.last_sync_attempt_at, '2026-07-07T12:11:00.000Z');
    assert.equal(afterSuccess.last_sync_status, 'success');
    assert.equal(afterSuccess.last_sync_error, '');
    assert.deepEqual(afterSuccess.last_sync_stats, { imported: 4, filtered: 1, failed: 0 });
    assert.equal(afterSuccess.sync_claim_id, null);
    assert.equal(afterSuccess.sync_claimed_until, null);

    console.log('PostgreSQL claim-bound sync report integration passed.');
  } finally {
    await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
