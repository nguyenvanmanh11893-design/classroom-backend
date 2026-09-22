import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createRequireAuth, requireRole, type SessionResolver } from '../src/middleware/auth.js';
import { errorHandler, requestIdMiddleware } from '../src/lib/api-error.js';
import { redactAuditMetadata } from '../src/services/audit.js';

const sessions: Record<string, Awaited<ReturnType<SessionResolver>>> = {
  admin: { user: { id: 'admin-1', name: 'Admin', email: 'admin@example.test', role: 'admin', isActive: true, preferredLocale: 'en' } },
  student: { user: { id: 'student-1', name: 'Student', email: 'student@example.test', role: 'student', isActive: true, preferredLocale: 'vi' } },
  inactive: { user: { id: 'student-2', name: 'Inactive', email: 'inactive@example.test', role: 'student', isActive: false, preferredLocale: 'en' } },
};

const resolveSession: SessionResolver = async (headers) => sessions[headers.get('x-test-session') ?? ''] ?? null;
type ErrorPayload = { error: { code: string }; requestId: string };
const app = express();
app.use(requestIdMiddleware);
app.use(createRequireAuth(resolveSession));
app.get('/session', (req, res) => res.json({ data: { id: req.user!.id, role: req.user!.role } }));
app.get('/admin', requireRole('admin'), (_req, res) => res.json({ data: { allowed: true } }));
app.use(errorHandler);

let baseUrl = '';
let server: ReturnType<typeof app.listen>;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test('missing session returns the standard 401 envelope and request id', async () => {
  const response = await fetch(`${baseUrl}/session`, { headers: { 'x-request-id': 'auth-test-1' } });
  const payload = await response.json() as ErrorPayload;
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-request-id'), 'auth-test-1');
  assert.equal(payload.error.code, 'AUTH_REQUIRED');
  assert.equal(payload.requestId, 'auth-test-1');
});

test('valid session reaches a protected route', async () => {
  const response = await fetch(`${baseUrl}/session`, { headers: { 'x-test-session': 'student' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { id: 'student-1', role: 'student' } });
});

test('student cannot reach an admin route', async () => {
  const response = await fetch(`${baseUrl}/admin`, { headers: { 'x-test-session': 'student' } });
  const payload = await response.json() as ErrorPayload;
  assert.equal(response.status, 403);
  assert.equal(payload.error.code, 'FORBIDDEN');
});

test('inactive session is rejected before authorization', async () => {
  const response = await fetch(`${baseUrl}/session`, { headers: { 'x-test-session': 'inactive' } });
  const payload = await response.json() as ErrorPayload;
  assert.equal(response.status, 403);
  assert.equal(payload.error.code, 'ACCOUNT_INACTIVE');
});

test('admin reaches an admin route', async () => {
  const response = await fetch(`${baseUrl}/admin`, { headers: { 'x-test-session': 'admin' } });
  assert.equal(response.status, 200);
});

test('audit metadata redacts credentials and direct identifiers', () => {
  assert.deepEqual(redactAuditMetadata({
    changed: { role: 'student', email: 'person@example.test' },
    password: 'never-log-this',
    authorization: 'Bearer secret',
  }), {
    changed: { role: 'student', email: '[REDACTED]' },
    password: '[REDACTED]',
    authorization: '[REDACTED]',
  });
});
