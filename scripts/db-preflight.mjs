import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

const target = process.env.NODE_ENV === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
if (!process.env[target]) throw new Error(`${target} is required`);
const pool = new pg.Pool({ connectionString: process.env[target], connectionTimeoutMillis: 10000, statement_timeout: 15000, application_name: 'classroom-preflight-readonly' });
let client;
let stage = 'connect';
async function query(name, statement) {
  stage = name;
  return client.query(statement);
}
try {
  client = await pool.connect();
  await query('begin-read-only', 'BEGIN READ ONLY');
  stage = 'read-local-journal';
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  const history = (await query('migration-history', 'SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
  const last = Number(history.at(-1)?.created_at ?? 0);
  const pending = journal.entries.filter(entry => entry.when > last).map(entry => entry.tag);
  const mismatches = [];
  const lineEndingOnly = [];
  for (const entry of journal.entries) {
    const applied = history.find(row => Number(row.created_at) === entry.when);
    if (!applied) continue;
    stage = `read-local-migration:${entry.tag}`;
    const source = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
    const hash = text => createHash('sha256').update(text).digest('hex');
    if (hash(source) !== applied.hash) {
      const lf = source.replace(/\r\n/g, '\n');
      if ([hash(lf), hash(lf.replace(/\n/g, '\r\n'))].includes(applied.hash)) lineEndingOnly.push(entry.tag);
      else mismatches.push(entry.tag);
    }
  }
  const columns = (await query('schema-columns', "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'")).rows;
  const has = (table, column) => columns.some(row => row.table_name === table && row.column_name === column);
  const active = has('enrollments', 'status') ? "WHERE status='active'" : '';
  const checks = {};
  for (const [name, sql] of [
    ['invalidCapacity', 'SELECT id,capacity FROM classes WHERE capacity<=0 ORDER BY id'],
    ['overCapacity', `SELECT c.id,c.capacity,count(e.student_id)::int AS enrolled FROM classes c JOIN (SELECT * FROM enrollments ${active}) e ON e.class_id=c.id GROUP BY c.id HAVING count(e.student_id)>c.capacity ORDER BY c.id`],
    ['invalidTeachers', `SELECT c.id AS class_id FROM classes c LEFT JOIN "user" u ON u.id=c.teacher_id WHERE u.id IS NULL OR u.role<>'teacher' ${has('user', 'is_active') ? 'OR NOT u.is_active' : ''} ORDER BY c.id`],
    ['legacyStatus', 'SELECT status::text,count(*)::int FROM classes GROUP BY status ORDER BY status'],
    ['legacySchedulesToReview', `SELECT c.id FROM classes c WHERE jsonb_typeof(c.schedules)<>'array' OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.schedules)='array' THEN c.schedules ELSE '[]'::jsonb END) item
      WHERE NOT COALESCE(jsonb_typeof(item)='object' AND item ?& array['dayOfWeek','startTime','endTime']
        AND (item->>'dayOfWeek') ~ '^[1-7]$' AND (item->>'startTime') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND (item->>'endTime') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND (item->>'startTime') < (item->>'endTime'), false)
    ) ORDER BY c.id`],
  ]) checks[name] = (await query(name, sql)).rows;
  checks.classInventory = (await query('class-inventory', `SELECT id,name,status::text ${has('classes', 'semester_id') ? ',semester_id,lifecycle_status' : ''} FROM classes ORDER BY id`)).rows;
  if (has('classes', 'semester_id')) {
    checks.classesWithoutSemester = (await query('classes-without-semester', 'SELECT id,lifecycle_status,archived_at FROM classes WHERE semester_id IS NULL ORDER BY id')).rows;
    checks.lifecycleToReview = (await query('lifecycle-review', 'SELECT id,legacy_status,lifecycle_status FROM classes WHERE status_migration_review_required<>0 ORDER BY id')).rows;
    checks.semesters = (await query('semesters', 'SELECT id,code,starts_on::date::text,ends_on::date::text,registration_starts_on::date::text,registration_ends_on::date::text FROM semesters ORDER BY id')).rows;
  }
  await query('end-read-only', 'ROLLBACK');
  const blockers = [];
  if (checks.invalidCapacity.length) blockers.push('Resolve capacity <= 0 before migration 0007.');
  if (mismatches.length) blockers.push('Applied migration differs from local file; investigate before migrating.');
  if (!journal.entries.some(entry => entry.when === last)) blockers.push('Latest database migration is not in the local journal. Investigate before migrating.');
  console.log(JSON.stringify({ target, readOnly: true, latestKnownMigration: journal.entries.find(entry => entry.when === last)?.tag ?? 'unknown', pending, migrationHashMismatches: mismatches, lineEndingOnly, blockers, checks }, null, 2));
  if (blockers.length) process.exitCode = 1;
} catch (error) {
  // Classify transport failures without printing credentials, SQL or driver config.
  const message = String(error.message ?? error.cause?.message ?? '');
  const reason = /timeout|timed out/i.test(message) ? 'Connection or query timed out'
    : /ECONNRESET|connection terminated|socket hang up/i.test(message) ? 'Database connection was interrupted'
    : /certificate|TLS|SSL/i.test(message) ? 'TLS connection failed'
    : /JSON|Unexpected token/i.test(message) ? 'Local migration journal is not valid JSON'
    : 'Inspect the reported stage and error code';
  console.error(JSON.stringify({ error: 'Preflight failed', target, stage, code: error.code ?? error.cause?.code ?? 'UNKNOWN', reason, hint: 'Preflight is read-only. Retry this check before deciding whether any migration is needed.' }));
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
