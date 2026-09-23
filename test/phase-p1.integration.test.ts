import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { readFile } from 'node:fs/promises';

test('P1 acceptance on isolated PostgreSQL', async t => {
  assert.equal(process.env.NODE_ENV, 'test', 'Run with NODE_ENV=test');
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const target = new URL(process.env.TEST_DATABASE_URL);
  if (process.env.DATABASE_URL) {
    const production = new URL(process.env.DATABASE_URL);
    assert.notEqual(`${target.hostname.replace('-pooler.', '.')}${target.pathname}`, `${production.hostname.replace('-pooler.', '.')}${production.pathname}`, 'Refusing to run against production');
  }
  const { pool } = await import('../src/db/index.js');
  const { default: classRoutes } = await import('../src/routes/classes.js');
  const { default: enrollmentRoutes } = await import('../src/routes/enrollments.js');
  const { default: dashboardRoutes } = await import('../src/routes/dashboard.js');
  const { errorHandler, requestIdMiddleware } = await import('../src/lib/api-error.js');
  const tag = `p1-${randomUUID()}`;
  const admin = `${tag}-admin`, teacher = `${tag}-teacher`, teacher2 = `${tag}-teacher2`;
  const students = Array.from({ length: 10 }, (_, i) => `${tag}-student${i}`);
  const users = [admin, teacher, teacher2, ...students];
  let subjectId = 0, departmentId = 0, semesterId = 0, semester2 = 0;
  const app = express(); app.use(express.json()); app.use(requestIdMiddleware);
  // Test-only identity injection: production still uses Better Auth middleware.
  app.use((req, _res, next) => { const id = req.header('x-test-user') ?? admin; req.user = { id, name: id, email: `${id}@example.test`, role: id === admin ? 'admin' : id === teacher || id === teacher2 ? 'teacher' : 'student', isActive: true, preferredLocale: 'en' }; next(); });
  app.use('/classes', classRoutes); app.use(enrollmentRoutes); app.use(dashboardRoutes); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function api(path: string, method = 'GET', body?: unknown, actor = admin) {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': actor }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  }
  const schedule = (dayOfWeek: number, startTime = '09:00', endTime = '10:00') => [{ dayOfWeek, startTime, endTime }];
  const payload = (schedules: ReturnType<typeof schedule>, extra = {}) => ({ name: tag, subjectId, semesterId, teacherId: teacher, capacity: 10, lifecycleStatus: 'open', schedules, ...extra });
  async function create(schedules: ReturnType<typeof schedule>, extra = {}) {
    const result = await api('/classes', 'POST', payload(schedules, extra));
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.data.id as number;
  }
  async function join(classId: number, studentId = students[0]!, inviteCode?: string) {
    return api(`/classes/${classId}/enrollments`, 'POST', { studentId, ...(inviteCode ? { inviteCode } : {}) }, studentId);
  }
  try {
    for (const id of users) await pool.query('INSERT INTO "user"(id,name,email,role,is_active,email_verified) VALUES ($1,$1,$2,$3,true,true)', [id, `${id}@example.test`, id === admin ? 'admin' : id === teacher || id === teacher2 ? 'teacher' : 'student']);
    departmentId = (await pool.query('INSERT INTO departments(code,name) VALUES ($1,$1) RETURNING id', [tag])).rows[0].id;
    subjectId = (await pool.query('INSERT INTO subjects(code,name,department_id) VALUES ($1,$1,$2) RETURNING id', [tag, departmentId])).rows[0].id;
    for (const code of [tag, `${tag}-2`]) {
      const id = (await pool.query("INSERT INTO semesters(code,name,starts_on,ends_on,registration_starts_on,registration_ends_on,status) VALUES ($1,$1,'2000-01-01','2100-12-31','2000-01-01','2100-12-31','active') RETURNING id", [code])).rows[0].id;
      if (!semesterId) semesterId = id; else semester2 = id;
    }
    await t.test('migration 0004–0008 rehearsal preserves legacy JSON including non-arrays', async () => {
      const schema = `rehearsal_${randomUUID().replaceAll('-', '')}`;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
        for (const entry of journal.entries) {
          if (entry.idx === 4) {
            await client.query("INSERT INTO departments(code,name) VALUES ('legacy','legacy')");
            await client.query("INSERT INTO subjects(code,name,department_id) VALUES ('legacy','legacy',1)");
            await client.query(`INSERT INTO "user"(id,name,email,email_verified,role) VALUES ('legacy','legacy','legacy@example.test',true,'teacher')`);
            await client.query(`INSERT INTO classes(subject_id,teacher_id,invite_code,name,schedules) VALUES (1,'legacy','a','legacy','[{"dayOfWeek":1,"startTime":"09:00","endTime":"10:00"}]'),(1,'legacy','b','unparsed','{"day":"Monday"}')`);
          }
          const source = (await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8')).replaceAll('"public".', `"${schema}".`);
          for (const statement of source.split('--> statement-breakpoint')) if (statement.trim()) await client.query(statement);
        }
        assert.equal((await client.query('SELECT count(*)::int n FROM class_schedules')).rows[0].n, 1);
        assert.equal((await client.query('SELECT lifecycle_status FROM classes WHERE id=1')).rows[0].lifecycle_status, 'open');
        assert.deepEqual((await client.query('SELECT schedules FROM classes WHERE id=2')).rows[0].schedules, { day: 'Monday' });
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
    await t.test('valid schedule SQL, touching endpoints and overlapping semesters', async () => {
      await create(schedule(1));
      await create(schedule(1, '10:00', '11:00'));
      const conflict = await api('/classes', 'POST', payload(schedule(1, '09:30', '10:30'), { semesterId: semester2 }));
      assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'TEACHER_SCHEDULE_CONFLICT');
      const own = await api('/classes', 'POST', payload([...schedule(2), ...schedule(2, '09:30', '10:30')]));
      assert.equal(own.status, 409); assert.equal(own.body.error.code, 'CLASS_SCHEDULE_CONFLICT');
    });
    await t.test('legacy UI payload rejected; current create/detail/PATCH contract works', async () => {
      const legacy = await api('/classes', 'POST', { name: tag, subjectId, teacherId: teacher, capacity: 50, status: 'active' });
      assert.equal(legacy.status, 400);
      const id = await create([]);
      const updated = await api(`/classes/${id}`, 'PATCH', { name: 'Edited', semesterId: semester2 });
      assert.equal(updated.status, 200);
      const detail = await api(`/classes/${id}`);
      assert.equal(detail.body.data.semesterId, semester2); assert.equal(detail.body.data.teacherId, teacher);
      assert.equal(detail.body.data.name, 'Edited');
    });
    await t.test('concurrent creates cannot double-book one teacher', async () => {
      const results = await Promise.all([api('/classes', 'POST', payload(schedule(3))), api('/classes', 'POST', payload(schedule(3)))]);
      assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    });
    await t.test('schedule PATCH protects enrolled students and preserves original on rejection', async () => {
      const a = await create(schedule(4)); const b = await create(schedule(5), { teacherId: teacher2 });
      assert.equal((await join(a)).status, 201); assert.equal((await join(b)).status, 201);
      const result = await api(`/classes/${b}`, 'PATCH', { schedules: schedule(4) });
      assert.equal(result.status, 409); assert.equal(result.body.error.code, 'STUDENT_SCHEDULE_CONFLICT');
      assert.equal((await api(`/classes/${b}`)).body.data.schedules[0].dayOfWeek, 5);
    });
    await t.test('concurrent edits cannot double-book teacher', async () => {
      const a = await create([], { teacherId: teacher2 }); const b = await create([], { teacherId: teacher2 });
      const results = await Promise.all([api(`/classes/${a}`, 'PATCH', { schedules: schedule(6) }), api(`/classes/${b}`, 'PATCH', { schedules: schedule(6) })]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    });
    await t.test('invite is bound to class and wrong-class attempts do not consume usage', async () => {
      const a = await create([]); const b = await create([]);
      const invite = await api(`/classes/${a}/invites`, 'POST', { maxUses: 1 }); assert.equal(invite.status, 201);
      const wrong = await join(b, students[1], invite.body.data.code);
      assert.equal(wrong.status, 409); assert.equal(wrong.body.error.code, 'INVITE_INVALID');
      assert.equal((await pool.query('SELECT used_count FROM class_invites WHERE id=$1', [invite.body.data.id])).rows[0].used_count, 0);
      assert.equal((await join(a, students[1], invite.body.data.code)).status, 201);
      assert.equal((await join(a, students[2], invite.body.data.code)).body.error.code, 'INVITE_EXHAUSTED');
    });
    await t.test('join by code, rotate remaining uses, roster access and cancellation', async () => {
      const id = await create([]);
      const issued = await api(`/classes/${id}/invites`, 'POST', { maxUses: 2 });
      assert.equal(issued.status, 201);
      const first = await api('/enrollments/join', 'POST', { code: issued.body.data.code }, students[8]);
      assert.equal(first.status, 201); assert.equal(first.body.data.classId, id);
      const rotated = await api(`/classes/${id}/invites/${issued.body.data.id}/rotate`, 'POST', {});
      assert.equal(rotated.status, 201); assert.equal(rotated.body.data.maxUses, 1);
      assert.equal((await api('/enrollments/join', 'POST', { code: issued.body.data.code }, students[9])).status, 409);
      assert.equal((await api('/enrollments/join', 'POST', { code: rotated.body.data.code }, students[9])).status, 201);
      assert.equal((await api(`/classes/${id}/invites`, 'GET', undefined, students[8])).status, 403);
      assert.equal((await api(`/classes/${id}/roster?page=0`)).status, 400);
      assert.equal((await api(`/classes/${id}/enrollments/${students[8]}`, 'DELETE', undefined, students[8])).status, 200);
    });
    await t.test('last seat cannot be taken twice; reduction below active count rejected', async () => {
      const id = await create([], { capacity: 1 });
      const results = await Promise.all([join(id, students[3]), join(id, students[4])]);
      assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
      const other = await create([], { capacity: 3 }); await join(other, students[3]); await join(other, students[4]);
      const result = await api(`/classes/${other}`, 'PATCH', { capacity: 1 });
      assert.equal(result.body.error.code, 'CAPACITY_BELOW_ACTIVE_ENROLLMENT');
    });
    await t.test('dashboard counts classes once in available/near/full buckets', async () => {
      const a = await create([], { semesterId: semester2, capacity: 10 });
      const b = await create([], { semesterId: semester2, capacity: 10 });
      await pool.query("INSERT INTO enrollments(student_id,class_id,status) SELECT unnest($1::text[]),$2,'active'", [students.slice(0, 8), a]);
      await pool.query("INSERT INTO enrollments(student_id,class_id,status) SELECT unnest($1::text[]),$2,'active'", [students, b]);
      const result = await api(`/dashboard?semesterId=${semester2}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const buckets = Object.fromEntries(result.body.data.charts.capacityStatus.map((r: { key: string; value: number }) => [r.key, r.value]));
      assert.deepEqual(buckets, { available: 1, full: 1, near: 1 });
      assert.equal(result.body.data.summary.activeEnrollments, 18);
      assert.equal(result.body.data.summary.utilization, 18 / 30);
    });
    await t.test('concurrent enrollment and schedule edit cannot introduce a student overlap', async () => {
      const a = await create(schedule(7));
      const b = await create([], { teacherId: teacher2 });
      assert.equal((await join(a, students[9])).status, 201);
      const results = await Promise.all([api(`/classes/${b}`, 'PATCH', { schedules: schedule(7) }), join(b, students[9])]);
      assert.equal(results.filter(result => result.status < 300).length, 1, JSON.stringify(results));
      assert.equal(results.filter(result => result.status === 409 && result.body.error.code === 'STUDENT_SCHEDULE_CONFLICT').length, 1);
    });
    await t.test('semester assignment previews without writes and applies idempotently', async () => {
      const { assignmentInput, assignSemester, previewSemesterAssignment } = await import('../src/services/semester-assignment.js');
      const id = await create([]);
      await pool.query('UPDATE classes SET semester_id=NULL WHERE id=$1', [id]);
      const config = assignmentInput.parse({ semester: { code: tag, name: tag, startsOn: '2000-01-01', endsOn: '2100-12-31', registrationStartsOn: '2000-01-01', registrationEndsOn: '2100-12-31', status: 'active' }, classIds: [id] });
      const preview = await previewSemesterAssignment(config);
      assert.equal(preview.classes[0]?.semesterId, null);
      assert.equal((await pool.query('SELECT semester_id FROM classes WHERE id=$1', [id])).rows[0].semester_id, null);
      await assignSemester(config);
      assert.equal((await pool.query('SELECT semester_id FROM classes WHERE id=$1', [id])).rows[0].semester_id, semesterId);
      assert.deepEqual((await assignSemester(config)).assignedClassIds, []);
      await assert.rejects(assignSemester({ ...config, semester: { ...config.semester, code: `${tag}-other` } }), /another semester/);
      assert.equal((await pool.query('SELECT count(*)::int n FROM semesters WHERE code=$1', [`${tag}-other`])).rows[0].n, 0);
      await pool.query("DELETE FROM audit_logs WHERE entity_type='class' AND entity_id=$1 AND action='class.semester_assigned'", [String(id)]);
      const conflicting = await create([]);
      await pool.query('UPDATE classes SET semester_id=NULL WHERE id=$1', [conflicting]);
      await pool.query("INSERT INTO class_schedules(class_id,day_of_week,start_time,end_time) VALUES ($1,1,'09:00','10:00')", [conflicting]);
      await assert.rejects(assignSemester({ ...config, classIds: [conflicting] }), /overlapping class schedule/);
      assert.equal((await pool.query('SELECT semester_id FROM classes WHERE id=$1', [conflicting])).rows[0].semester_id, null);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    // Only remove records owned by this randomly named fixture.
    await pool.query('DELETE FROM audit_logs WHERE actor_id=ANY($1::text[])', [users]);
    await pool.query('DELETE FROM enrollment_events WHERE class_id IN (SELECT id FROM classes WHERE subject_id=$1)', [subjectId]);
    await pool.query('DELETE FROM class_invites WHERE class_id IN (SELECT id FROM classes WHERE subject_id=$1)', [subjectId]);
    await pool.query('DELETE FROM classes WHERE subject_id=$1', [subjectId]);
    await pool.query('DELETE FROM semesters WHERE id=ANY($1::int[])', [[semesterId, semester2]]);
    await pool.query('DELETE FROM subjects WHERE id=$1', [subjectId]);
    await pool.query('DELETE FROM departments WHERE id=$1', [departmentId]);
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users]);
    await pool.end();
  }
});
