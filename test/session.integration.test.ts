import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';

process.env.NODE_ENV = 'test';

const testUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(testUrl);
const email = `session-test-${randomUUID()}@example.test`;
const password = 'Test-password-123!';
const pool = enabled ? new Pool({ connectionString: testUrl, application_name: 'classroom-session-integration-test' }) : null;

let baseUrl = '';
let cookie = '';
let server: { close(callback: (error?: Error) => void): void } | undefined;

before(async () => {
  if (!enabled) return;
  process.env.BETTER_AUTH_URL = 'http://127.0.0.1:0';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  const { createApp } = await import('../src/app.js');
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', () => {
      const address = (server as unknown as { address(): AddressInfo }).address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      process.env.BETTER_AUTH_URL = baseUrl;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  if (pool) {
    await pool.query('delete from account where user_id in (select id from "user" where email = $1)', [email]);
    await pool.query('delete from session where user_id in (select id from "user" where email = $1)', [email]);
    await pool.query('delete from "user" where email = $1', [email]);
    await pool.end();
  }
});

test('Better Auth cookie session reaches a protected API and cannot elevate a student', { skip: !enabled && 'Set TEST_DATABASE_URL to an isolated migrated database' }, async () => {
  const signup = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Session Test Student', email, password, role: 'admin', isActive: false }),
  });
  assert.equal(signup.status, 200);
  const signupPayload = await signup.json() as { user: { id: string; role: string; isActive: boolean } };
  assert.equal(signupPayload.user.role, 'student');
  assert.equal(signupPayload.user.isActive, true);
  cookie = signup.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.notEqual(cookie, '');

  const protectedResponse = await fetch(`${baseUrl}/api/subjects`, { headers: { cookie } });
  assert.equal(protectedResponse.status, 200);

  const deniedResponse = await fetch(`${baseUrl}/api/users/${signupPayload.user.id}/access`, {
    method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  });
  const deniedPayload = await deniedResponse.json() as { error: { code: string } };
  assert.equal(deniedResponse.status, 403);
  assert.equal(deniedPayload.error.code, 'FORBIDDEN');
});
