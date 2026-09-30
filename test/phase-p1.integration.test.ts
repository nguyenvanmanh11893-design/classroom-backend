import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';

test('academic registration acceptance on isolated PostgreSQL', async t => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.ok(process.env.TEST_DATABASE_URL);
  const target = new URL(process.env.TEST_DATABASE_URL);
  if (process.env.DATABASE_URL) {
    const production = new URL(process.env.DATABASE_URL);
    assert.notEqual(`${target.hostname.replace('-pooler.', '.')}${target.pathname}`, `${production.hostname.replace('-pooler.', '.')}${production.pathname}`);
  }
  const { pool } = await import('../src/db/index.js');
  const { default: classes } = await import('../src/routes/classes.js');
  const { default: sessions } = await import('../src/routes/class-sessions.js');
  const { default: periods } = await import('../src/routes/registration-periods.js');
  const { default: profiles } = await import('../src/routes/profiles.js');
  const { default: slots } = await import('../src/routes/time-slots.js');
  const { default: enrollments } = await import('../src/routes/enrollments.js');
  const { default: semesters } = await import('../src/routes/semesters.js');
  const { default: users } = await import('../src/routes/users.js');
  const { errorHandler, requestIdMiddleware } = await import('../src/lib/api-error.js');
  const tag = `academic-${randomUUID()}`;
  const admin = `${tag}-admin`, teachers = Array.from({ length: 4 }, (_, i) => `${tag}-teacher-${i}`), students = Array.from({ length: 8 }, (_, i) => `${tag}-student-${i}`);
  const allUsers = [admin, ...teachers, ...students];
  const app = express(); app.use(express.json()); app.use(requestIdMiddleware);
  app.use((req, _res, next) => {
    const id = req.header('x-test-user') ?? admin;
    req.user = { id, name: id, email: `${id}@example.test`, role: id === admin ? 'admin' : teachers.includes(id) ? 'teacher' : 'student', isActive: true, preferredLocale: 'en' };
    next();
  });
  app.use('/classes', classes); app.use(sessions); app.use('/registration-periods', periods); app.use('/profiles', profiles); app.use('/time-slots', slots); app.use(enrollments); app.use('/semesters', semesters); app.use('/users', users); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function api(path: string, method = 'GET', body?: unknown, actor = admin) {
    const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': actor }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() as any };
  }
  const ok = (r: Awaited<ReturnType<typeof api>>, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body?.data; };
  const error = (r: Awaited<ReturnType<typeof api>>, code: string) => { assert.ok(r.status >= 400, JSON.stringify(r)); assert.equal(r.body.error.code, code); };
  let department = 0, semester = 0;
  const subjectIds: number[] = [], slotIds: number[] = [];
  let a = 0, b = 0, c = 0, d = 0, period = 0;
  const periodBody = (classIds: number[], extra = {}) => ({ name: tag, semesterId: semester, opensAt: new Date(Date.now() - 3600000).toISOString(), closesAt: new Date(Date.now() + 86400000).toISOString(), cancellationDeadline: new Date(Date.now() + 172800000).toISOString(), status: 'open', classIds, ...extra });
  const classBody = (extra = {}) => ({ name: tag, subjectId: subjectIds[0], semesterId: semester, teacherId: teachers[0], capacity: 10, lifecycleStatus: 'open', startsOn: '2090-03-01', endsOn: '2090-03-31', schedules: [{ dayOfWeek: 1, timeSlotId: slotIds[0] }], ...extra });
  const create = async (extra = {}) => ok(await api('/classes', 'POST', classBody(extra)), 201).id as number;
  const join = (classId: number, student = students[0]!) => api(`/classes/${classId}/enrollments`, 'POST', { studentId: student }, student);
  try {
    for (const id of allUsers) await pool.query('INSERT INTO "user"(id,name,email,email_verified,role,is_active) VALUES ($1,$1,$2,true,$3,true)', [id, `${id}@example.test`, id === admin ? 'admin' : teachers.includes(id) ? 'teacher' : 'student']);
    department = (await pool.query('INSERT INTO departments(code,name) VALUES ($1,$1) RETURNING id', [tag])).rows[0].id;
    for (let i = 0; i < 6; i++) subjectIds.push((await pool.query('INSERT INTO subjects(code,name,department_id) VALUES ($1,$1,$2) RETURNING id', [`${tag}-${i}`, department])).rows[0].id);
    semester = ok(await api('/semesters', 'POST', { code: tag, name: tag, startsOn: '2090-01-01', endsOn: '2090-12-31', status: 'active' }), 201).id;

    await t.test('migration rehearsal preserves legacy data and requires schedule review', async () => {
      const schema = `rehearsal_${randomUUID().replaceAll('-', '')}`, client = await pool.connect();
      try {
        await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
        const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
        for (const entry of journal.entries) {
          if (entry.idx === 4) {
            await client.query("INSERT INTO departments(code,name) VALUES ('legacy','legacy')");
            await client.query("INSERT INTO subjects(code,name,department_id) VALUES ('legacy','legacy',1)");
            await client.query(`INSERT INTO "user"(id,name,email,email_verified,role) VALUES ('legacy','legacy','legacy@example.test',true,'teacher')`);
            await client.query(`INSERT INTO classes(subject_id,teacher_id,invite_code,name,schedules) VALUES (1,'legacy','x','legacy','[{"dayOfWeek":1,"startTime":"09:00","endTime":"10:00"}]')`);
          }
          const source = (await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8')).replaceAll('"public".', `"${schema}".`);
          for (const statement of source.split('--> statement-breakpoint')) if (statement.trim()) await client.query(statement);
        }
        assert.equal((await client.query('SELECT count(*)::int n FROM class_schedules')).rows[0].n, 1);
        assert.equal((await client.query('SELECT schedule_review_required FROM classes')).rows[0].schedule_review_required, true);
        assert.equal((await client.query('SELECT count(*)::int n FROM class_sessions')).rows[0].n, 0);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });

    await t.test('academic profiles enforce self/admin permissions and account roles', async () => {
      assert.equal(ok(await api('/profiles/me', 'GET', undefined, students[0])).profile, null);
      for (const [i, teacher] of teachers.entries()) ok(await api(`/profiles/${teacher}`, 'PUT', { teacherCode: `${tag}-T${i}`, departmentId: department, employmentStatus: 'active' }));
      for (const [i, student] of students.entries()) ok(await api(`/profiles/${student}`, 'PUT', { studentCode: `${tag}-S${i}`, departmentId: department, admissionYear: 2026, academicStatus: 'studying' }));
      ok(await api('/profiles/me', 'PATCH', { phone: '0900000000' }, students[0]));
      error(await api('/profiles/me', 'PATCH', { academicStatus: 'studying' }, students[0]), 'VALIDATION_ERROR');
      error(await api(`/profiles/${students[1]}`, 'GET', undefined, students[0]), 'FORBIDDEN');
      error(await api(`/profiles/${teachers[0]}`, 'PUT', { teacherCode: 'x', departmentId: department }, teachers[0]), 'FORBIDDEN');
      error(await api(`/users/${students[0]}/access`, 'PATCH', { role: 'teacher' }), 'PROFILE_ROLE_CONFLICT');
      assert.ok(ok(await api('/profiles?role=student&search=' + tag)).length > 0);
    });

    await t.test('time slots and dated preview validate rules and boundaries', async () => {
      for (const [i, startTime] of ['09:00', '10:00', '14:00'].entries()) slotIds.push(ok(await api('/time-slots', 'POST', { name: `${tag}-${i}`, startTime, endTime: i === 0 ? '10:00' : i === 1 ? '11:00' : '15:00' }), 201).id);
      const plan = { teacherId: teachers[0], subjectId: subjectIds[0], semesterId: semester, startsOn: '2090-03-01', endsOn: '2090-03-31', schedules: [{ dayOfWeek: 1, timeSlotId: slotIds[0] }] };
      const preview = ok(await api('/classes/schedule-preview', 'POST', plan));
      assert.ok(preview.sessions.length >= 4);
      assert.ok(preview.sessions.every((s: {sessionDate: string}) => new Date(s.sessionDate).getUTCDay() === 1));
      error(await api('/classes/schedule-preview', 'POST', { ...plan, schedules: [...plan.schedules, ...plan.schedules] }), 'CLASS_SCHEDULE_CONFLICT');
      error(await api('/classes/schedule-preview', 'POST', { ...plan, startsOn: '2089-12-01' }), 'CLASS_OUTSIDE_SEMESTER');
      error(await api('/classes', 'POST', classBody({ schedules: [] })), 'SCHEDULE_REQUIRED');
      a = await create();
      error(await api(`/time-slots/${slotIds[0]}`, 'PATCH', { startTime: '08:00' }), 'TIME_SLOT_IN_USE');
    });

    await t.test('conflicts use actual dates and prohibit overlapping sections of one subject', async () => {
      b = await create({ teacherId: teachers[1], startsOn: '2090-04-01', endsOn: '2090-04-30' });
      error(await api('/classes', 'POST', classBody({ teacherId: teachers[1] })), 'SUBJECT_SCHEDULE_CONFLICT');
      error(await api('/classes', 'POST', classBody({ subjectId: subjectIds[1] })), 'TEACHER_SCHEDULE_CONFLICT');
      c = await create({ subjectId: subjectIds[1], teacherId: teachers[1] });
      d = await create({ subjectId: subjectIds[1], teacherId: teachers[1], schedules: [{ dayOfWeek: 1, timeSlotId: slotIds[1] }] });
      error(await api(`/semesters/${semester}`, 'PATCH', { startsOn: '2090-05-01' }), 'CLASS_OUTSIDE_SEMESTER');
    });

    await t.test('registration periods open before teaching and drive discovery', async () => {
      const draft = await create({ lifecycleStatus: 'draft', schedules: [], startsOn: undefined, endsOn: undefined });
      error(await api('/registration-periods', 'POST', periodBody([draft])), 'REGISTRATION_NOT_READY');
      error(await api('/registration-periods', 'POST', periodBody([a], { closesAt: '2090-05-01T00:00:00+07:00', cancellationDeadline: '2090-05-02T00:00:00+07:00' })), 'REGISTRATION_AFTER_CLASS_START');
      error(await api(`/classes/${a}`, 'GET', undefined, students[0]), 'CLASS_NOT_FOUND');
      period = ok(await api('/registration-periods', 'POST', periodBody([a, b, c, d])), 201).id;
      ok(await api(`/registration-periods/${period}`, 'PATCH', { classIds: [a, b, c, d] }));
      const catalog = ok(await api(`/classes?scope=catalog&semester=${semester}`, 'GET', undefined, students[0]));
      assert.equal(catalog.length, 4);
      assert.equal(ok(await api(`/classes?scope=mine&semester=${semester}`, 'GET', undefined, students[0])).length, 0);
      ok(await api(`/classes/${a}/sessions`, 'GET', undefined, students[0]));
      error(await api(`/classes/${draft}`, 'GET', undefined, students[0]), 'CLASS_NOT_FOUND');
      error(await api(`/classes/${a}/sessions`, 'POST', { sessionDate: '2090-03-02', timeSlotId: slotIds[0], note: 'unauthorized' }, teachers[0]), 'FORBIDDEN');
    });

    await t.test('registration checks duplicate subjects, every session, and profile eligibility', async () => {
      ok(await join(a), 201);
      error(await join(b), 'SUBJECT_ALREADY_ENROLLED');
      error(await join(c), 'STUDENT_SCHEDULE_CONFLICT');
      ok(await join(d), 201);
      error(await join(a), 'ALREADY_ENROLLED');
      const invite = ok(await api(`/classes/${b}/invites`, 'POST', { maxUses: 2 }), 201);
      error(await api('/enrollments/join', 'POST', { code: invite.code }, students[0]), 'SUBJECT_ALREADY_ENROLLED');
      assert.equal((await pool.query('SELECT used_count FROM class_invites WHERE id=$1', [invite.id])).rows[0].used_count, 0);
      ok(await api('/enrollments/join', 'POST', { code: invite.code }, students[1]), 201);
      await pool.query("UPDATE student_profiles SET academic_status='suspended' WHERE user_id=$1", [students[2]]);
      error(await join(a, students[2]), 'STUDENT_NOT_ELIGIBLE');
      await pool.query("UPDATE student_profiles SET academic_status='studying' WHERE user_id=$1", [students[2]]);
      await pool.query('DELETE FROM student_profiles WHERE user_id=$1', [students[2]]);
      error(await join(a, students[2]), 'STUDENT_PROFILE_REQUIRED');
      ok(await api(`/profiles/${students[2]}`, 'PUT', { studentCode: `${tag}-S2`, departmentId: department, admissionYear: 2026 }));
      assert.equal(ok(await api(`/classes?scope=mine&semester=${semester}`, 'GET', undefined, students[0])).length, 2);
      assert.ok(ok(await api('/timetable?from=2090-03-01&to=2090-03-31', 'GET', undefined, students[0])).length > 0);
    });

    await t.test('reschedule/cancel/makeup protects enrolled students and keeps audit history', async () => {
      const first = ok(await api(`/classes/${a}/sessions`))[0];
      error(await api(`/classes/${a}/sessions/${first.id}`, 'PATCH', { timeSlotId: slotIds[1], note: 'conflict' }), 'STUDENT_SCHEDULE_CONFLICT');
      ok(await api(`/classes/${a}/sessions/${first.id}`, 'PATCH', { status: 'cancelled', note: 'Holiday' }));
      assert.equal(ok(await api(`/classes/${a}/sessions/${first.id}`, 'PATCH', { note: 'Holiday confirmed' })).status, 'cancelled');
      ok(await api(`/classes/${a}/sessions`, 'POST', { sessionDate: first.sessionDate, timeSlotId: slotIds[2], note: 'Makeup' }), 201);
      ok(await api(`/classes/${a}`, 'PATCH', { teacherId: teachers[0], startsOn: '2090-03-01', endsOn: '2090-03-31', schedules: [{ dayOfWeek: 1, timeSlotId: slotIds[0] }], name: 'Renamed with unchanged schedule' }));
      assert.equal(ok(await api(`/classes/${a}/sessions`)).find((s: {id: number}) => s.id === first.id).status, 'cancelled');
      error(await api(`/classes/${a}`, 'PATCH', { schedules: [{ dayOfWeek: 2, timeSlotId: slotIds[0] }] }), 'SCHEDULE_HAS_EXCEPTIONS');
      assert.ok((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE actor_id=$1 AND entity_type='class_session'", [admin])).rows[0].n >= 2);
      error(await api(`/classes/${a}/sessions/${first.id}`, 'PATCH', { sessionDate: '2000-01-01', note: 'past' }), 'PAST_SESSION_IMMUTABLE');
    });

    await t.test('changing subject/semester cannot invalidate existing registrations', async () => {
      error(await api(`/classes/${d}`, 'PATCH', { subjectId: subjectIds[0] }), 'SUBJECT_ALREADY_ENROLLED');
      error(await api(`/classes/${a}`, 'PATCH', { capacity: 0 }), 'VALIDATION_ERROR');
      error(await api(`/registration-periods/${period}`, 'PATCH', { classIds: [b, c, d] }), 'REGISTRATION_PERIOD_IN_USE');
      error(await api(`/registration-periods/${period}`, 'PATCH', { status: 'draft' }), 'REGISTRATION_TRANSITION_INVALID');
    });

    await t.test('closing a period stops direct and invite registration but respects cancellation deadline', async () => {
      const invite = ok(await api(`/classes/${c}/invites`, 'POST', { maxUses: 2 }), 201);
      ok(await api(`/registration-periods/${period}`, 'PATCH', { status: 'closed' }));
      error(await join(c, students[2]), 'REGISTRATION_CLOSED');
      error(await api('/enrollments/join', 'POST', { code: invite.code }, students[2]), 'REGISTRATION_CLOSED');
      ok(await api(`/classes/${a}/enrollments/${students[0]}`, 'DELETE', undefined, students[0]));
      ok(await api(`/registration-periods/${period}`, 'PATCH', { status: 'open' }));
      ok(await join(a), 201);
      const event = (await pool.query('SELECT registration_period_id FROM enrollment_events WHERE class_id=$1 AND student_id=$2 ORDER BY occurred_at DESC LIMIT 1', [a, students[0]])).rows[0];
      assert.equal(event.registration_period_id, period);
      await pool.query("UPDATE registration_periods SET opens_at=now()-interval '3 days',closes_at=now()-interval '2 days',cancellation_deadline=now()-interval '1 day' WHERE id=$1", [period]);
      error(await api(`/classes/${a}/enrollments/${students[0]}`, 'DELETE', undefined, students[0]), 'CANCELLATION_CLOSED');
    });

    await t.test('concurrent creation and last-seat registration remain atomic', async () => {
      const body = classBody({ subjectId: subjectIds[2], teacherId: teachers[2], schedules: [{ dayOfWeek: 3, timeSlotId: slotIds[0] }], capacity: 1 });
      const created = await Promise.all([api('/classes', 'POST', body), api('/classes', 'POST', body)]);
      assert.deepEqual(created.map(r => r.status).sort(), [201, 409]);
      const classId = created.find(r => r.status === 201)!.body.data.id;
      ok(await api('/registration-periods', 'POST', periodBody([classId])), 201);
      const results = await Promise.all([join(classId, students[3]), join(classId, students[4])]);
      assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
      error(results.find(r => r.status === 409)!, 'CLASS_CAPACITY_FULL');
    });

    await t.test('concurrent enrollments into different sections of the same subject cannot both succeed', async () => {
      const x = await create({ subjectId: subjectIds[3], teacherId: teachers[3], schedules: [{ dayOfWeek: 4, timeSlotId: slotIds[0] }] });
      const y = await create({ subjectId: subjectIds[3], teacherId: teachers[3], schedules: [{ dayOfWeek: 5, timeSlotId: slotIds[0] }] });
      ok(await api('/registration-periods', 'POST', periodBody([x, y])), 201);
      const results = await Promise.all([join(x, students[5]), join(y, students[5])]);
      assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
      error(results.find(r => r.status === 409)!, 'SUBJECT_ALREADY_ENROLLED');
    });

    await t.test('enrollment racing with a session move cannot introduce an overlap', async () => {
      const x = await create({ subjectId: subjectIds[4], teacherId: teachers[2], schedules: [{ dayOfWeek: 6, timeSlotId: slotIds[0] }] });
      const y = await create({ subjectId: subjectIds[5], teacherId: teachers[3], schedules: [{ dayOfWeek: 7, timeSlotId: slotIds[0] }] });
      ok(await api('/registration-periods', 'POST', periodBody([x, y])), 201);
      ok(await join(x, students[6]), 201);
      const target = ok(await api(`/classes/${x}/sessions`))[0], moving = ok(await api(`/classes/${y}/sessions`))[0];
      const results = await Promise.all([join(y, students[6]), api(`/classes/${y}/sessions/${moving.id}`, 'PATCH', { sessionDate: target.sessionDate, note: 'Concurrent move' })]);
      assert.equal(results.filter(r => r.status < 300).length, 1, JSON.stringify(results));
      error(results.find(r => r.status >= 400)!, 'STUDENT_SCHEDULE_CONFLICT');
    });

    await t.test('local-test-accounts authenticate through the real application', async () => {
      const credentials = JSON.parse(await readFile(new URL('../local-test-accounts.json', import.meta.url), 'utf8'));
      const { createApp } = await import('../src/app.js');
      const real = createApp().listen(0, '127.0.0.1');
      await new Promise<void>(resolve => real.once('listening', resolve));
      const origin = `http://127.0.0.1:${(real.address() as AddressInfo).port}`;
      try {
        for (const account of credentials.accounts) {
          const response = await fetch(`${origin}/api/auth/sign-in/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: account.email, password: account.password }) });
          assert.equal(response.status, 200, `Login failed for ${account.role}`);
          const cookie = response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
          assert.ok(cookie);
          const profile = await fetch(`${origin}/api/profiles/me`, { headers: { cookie } });
          assert.equal(profile.status, 200);
          const profileBody = await profile.json() as any;
          assert.equal(profileBody.data.role, account.role);
          if (account.role !== 'admin') assert.equal((await fetch(`${origin}/api/time-slots`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
          await fetch(`${origin}/api/auth/sign-out`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
        }
      } finally { await new Promise<void>(resolve => real.close(() => resolve())); }
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.query('DELETE FROM audit_logs WHERE actor_id=ANY($1::text[])', [allUsers]);
    await pool.query('DELETE FROM enrollment_events WHERE class_id IN (SELECT id FROM classes WHERE subject_id=ANY($1::int[]))', [subjectIds]);
    await pool.query('DELETE FROM class_invites WHERE class_id IN (SELECT id FROM classes WHERE subject_id=ANY($1::int[]))', [subjectIds]);
    await pool.query('DELETE FROM classes WHERE subject_id=ANY($1::int[])', [subjectIds]);
    await pool.query('DELETE FROM registration_periods WHERE semester_id=$1', [semester]);
    await pool.query('DELETE FROM semesters WHERE id=$1', [semester]);
    await pool.query('DELETE FROM student_profiles WHERE user_id=ANY($1::text[])', [allUsers]);
    await pool.query('DELETE FROM teacher_profiles WHERE user_id=ANY($1::text[])', [allUsers]);
    await pool.query('DELETE FROM subjects WHERE id=ANY($1::int[])', [subjectIds]);
    await pool.query('DELETE FROM departments WHERE id=$1', [department]);
    await pool.query('DELETE FROM time_slots WHERE id=ANY($1::int[])', [slotIds]);
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [allUsers]);
    await pool.end();
  }
});
