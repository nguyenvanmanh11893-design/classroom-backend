import 'dotenv/config';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { semesterInput, semesterPatchInput } from '../src/routes/semesters.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL) && process.env.NODE_ENV === 'test';
const pool = enabled ? new Pool({ connectionString: process.env.TEST_DATABASE_URL, application_name: 'classroom-crud-regression' }) : null;
after(async () => pool?.end());

test('R2: semester PATCH accepts partial form fields; merged date rules remain enforced', () => {
  assert.deepEqual(semesterPatchInput.parse({ name: 'Renamed' }), { name: 'Renamed' });
  assert.equal(semesterPatchInput.safeParse({ id: 1 }).success, false);
  assert.equal(semesterPatchInput.safeParse({ startsOn: '2026-02-30' }).success, false);
  const changed = semesterPatchInput.parse({ startsOn: '2028-02-29' });
  assert.equal(changed.startsOn?.toISOString(), '2028-02-29T00:00:00.000Z');
  assert.equal(semesterInput.safeParse({ code: 'S', name: 'S', startsOn: '2026-06-10', endsOn: '2026-06-01', registrationStartsOn: '2026-06-01', registrationEndsOn: '2026-06-02' }).success, false);
});

test('R3: semester date validation rejects impossible dates and accepts leap day', () => {
  const base = { code: 'S', name: 'S', endsOn: '2028-03-01', registrationStartsOn: '2028-02-29', registrationEndsOn: '2028-02-29' };
  assert.equal(semesterInput.safeParse({ ...base, startsOn: '2026-02-30' }).success, false);
  assert.equal(semesterInput.safeParse({ ...base, startsOn: '2028-02-29' }).success, true);
});

test('R1/R4: migrated test DB rejects subject deletion with a class and duplicate codes', { skip: !enabled && 'Set NODE_ENV=test and TEST_DATABASE_URL to an isolated migrated database' }, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const departmentCode = `D${suffix}`; const subjectCode = `S${suffix}`;
  const client = await pool!.connect();
  try {
    await client.query('begin');
    const department = await client.query<{ id: number }>('insert into departments (code,name) values ($1,$2) returning id', [departmentCode, departmentCode]);
    const subject = await client.query<{ id: number }>('insert into subjects (department_id,code,name) values ($1,$2,$3) returning id', [department.rows[0]!.id, subjectCode, subjectCode]);
    const teacherId = `crud-teacher-${suffix}`;
    await client.query('insert into "user" (id,name,email,email_verified,role,is_active,preferred_locale) values ($1,$2,$3,true,\'teacher\',true,\'en\')', [teacherId, teacherId, `${teacherId}@example.test`]);
    await client.query('insert into classes (subject_id,teacher_id,invite_code,name) values ($1,$2,$3,$4)', [subject.rows[0]!.id, teacherId, `invite-${suffix}`, 'Regression class']);
    await client.query('savepoint before_constraint_check');
    await assert.rejects(client.query('delete from subjects where id=$1', [subject.rows[0]!.id]), { code: '23503' });
    await client.query('rollback to savepoint before_constraint_check');
    await assert.rejects(client.query('insert into departments (code,name) values ($1,$2)', [departmentCode, 'duplicate']), { code: '23505' });
  } finally { await client.query('rollback'); client.release(); }
});
