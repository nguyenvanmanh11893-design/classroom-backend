import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';

const testUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(testUrl) && process.env.NODE_ENV === 'test';
const pool = enabled ? new Pool({ connectionString: testUrl, application_name: 'classroom-integration-test' }) : null;

after(async () => { await pool?.end(); });

test('node-postgres supports a serializable transaction', { skip: !enabled && 'Set NODE_ENV=test and TEST_DATABASE_URL to an isolated database' }, async () => {
  const client = await pool!.connect();
  try {
    await client.query('begin isolation level serializable');
    const result = await client.query<{ isolation: string }>('select current_setting(\'transaction_isolation\') isolation');
    assert.equal(result.rows[0]?.isolation, 'serializable');
    await client.query('rollback');
  } finally {
    client.release();
  }
});

test('concurrent demotions cannot remove the last active admin', { skip: !enabled && 'Set NODE_ENV=test and TEST_DATABASE_URL to an isolated database' }, async (context) => {
  const existing = await pool!.query<{ count: string }>('select count(*)::text count from "user" where role = \'admin\' and is_active = true');
  if (Number(existing.rows[0]?.count ?? 0) !== 0) {
    context.skip('Race fixture requires an empty, disposable migrated test database');
    return;
  }

  const first = `test-admin-${randomUUID()}`;
  const second = `test-admin-${randomUUID()}`;
  await pool!.query(
    'insert into "user" (id,name,email,email_verified,role,is_active,preferred_locale) values ($1,$2,$3,true,\'admin\',true,\'en\'),($4,$5,$6,true,\'admin\',true,\'en\')',
    [first, 'Test Admin One', `${first}@example.test`, second, 'Test Admin Two', `${second}@example.test`],
  );

  try {
    const { updateUserAccess } = await import('../src/services/users.js');
    const results = await Promise.allSettled([
      updateUserAccess(first, first, { role: 'student', isActive: undefined }, randomUUID()),
      updateUserAccess(first, second, { role: 'student', isActive: undefined }, randomUUID()),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const remaining = await pool!.query<{ count: string }>('select count(*)::text count from "user" where role = \'admin\' and is_active = true');
    assert.equal(Number(remaining.rows[0]?.count), 1);
  } finally {
    await pool!.query('delete from audit_logs where actor_id = $1 or entity_id = $1 or actor_id = $2 or entity_id = $2', [first, second]);
    await pool!.query('delete from "user" where id = $1 or id = $2', [first, second]);
  }
});
