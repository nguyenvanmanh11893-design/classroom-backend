import { randomBytes } from 'node:crypto';
import express from 'express';
import { and, asc, desc, eq, ilike, sql, inArray, or, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { classes, classSchedules, classSessions, departments, enrollments, semesters, subjects, teacherProfiles, registrationPeriods, registrationPeriodClasses } from '../db/schema/app.js';
import { user } from '../db/schema/auth.js';
import { ApiError } from '../lib/api-error.js';
import { pagination, parseListQuery } from '../lib/list-query.js';
import { requireRole } from '../middleware/auth.js';
import { writeAuditEvent } from '../services/audit.js';
import { serializable } from '../services/transaction.js';
import { assertClassSessions, generateSessions, resolveRules, ruleInput, schedulePlanInput, sessionStarted, type SessionInput } from '../services/class-schedule.js';
import { classVisibility } from '../services/class-access.js';
import { calendarDate } from '../lib/calendar.js';

const router = express.Router();

const classSelection = {
    id: classes.id, name: classes.name, description: classes.description, status: classes.status,
    semesterId: classes.semesterId, teacherId: classes.teacherId, subjectId: classes.subjectId,
    startsOn: classes.startsOn, endsOn: classes.endsOn, scheduleReviewRequired: classes.scheduleReviewRequired,
    activeEnrollmentCount: sql<number>`(SELECT count(*)::int FROM enrollments e WHERE e.class_id=classes.id AND e.status='active')`,
    capacity: classes.capacity, bannerUrl: classes.bannerUrl, bannerCldPubId: classes.bannerCldPubId,
    lifecycleStatus: classes.lifecycleStatus, archivedAt: classes.archivedAt, createdAt: classes.createdAt, updatedAt: classes.updatedAt,
    subject: { id: subjects.id, name: subjects.name, code: subjects.code, description: subjects.description },
    department: { id: departments.id, name: departments.name, code: departments.code, description: departments.description },
    teacher: { id: user.id, name: user.name, image: user.image },
};

const lifecycle = z.enum(['draft', 'open', 'closed', 'completed', 'cancelled']);
const inputFields = z.object({ subjectId: z.coerce.number().int().positive(), semesterId: z.coerce.number().int().positive(), teacherId: z.string().min(1).max(200), name: z.string().trim().min(2).max(255), bannerCldPubId: z.string().max(500).optional(), bannerUrl: z.url().max(2000).optional(), description: z.string().max(5000).optional(), capacity: z.coerce.number().int().positive().max(100000), lifecycleStatus: lifecycle, startsOn: calendarDate.optional(), endsOn: calendarDate.optional(), schedules: z.array(ruleInput).max(28) }).strict();
const createClassSchema = inputFields;
const patchClassSchema = inputFields.partial().extend({ archive: z.boolean().optional() }).strict();

function assertTransition(from: z.infer<typeof lifecycle>, to: z.infer<typeof lifecycle>) {
  const allowed: Record<z.infer<typeof lifecycle>, readonly string[]> = { draft: ['open', 'cancelled'], open: ['closed', 'cancelled'], closed: ['open', 'completed', 'cancelled'], completed: [], cancelled: [] };
  if (from !== to && !allowed[from].includes(to)) throw new ApiError(409, 'LIFECYCLE_TRANSITION_INVALID', 'Class lifecycle transition is not allowed', { from, to });
}

type ClassMutationDb = Pick<typeof db, 'select' | 'execute'>;

async function assertTeacher(tx: ClassMutationDb, teacherId: string) {
  const [teacher] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, teacherId), eq(user.role, 'teacher'), eq(user.isActive, true)));
  if (!teacher) throw new ApiError(400, 'TEACHER_INVALID', 'Teacher must be an active teacher');
  const [profile] = await tx.select().from(teacherProfiles).where(eq(teacherProfiles.userId, teacherId));
  if (profile?.employmentStatus !== 'active') throw new ApiError(409, 'TEACHER_PROFILE_REQUIRED', 'Teacher needs an active academic profile');
}

router.post('/schedule-preview', requireRole('admin'), async (req, res) => {
  const value = schedulePlanInput.extend({ teacherId: z.string().min(1), subjectId: z.number().int().positive(), semesterId: z.number().int().positive(), classId: z.number().int().positive().optional() }).parse(req.body);
  const result = await serializable(async tx => {
    const rules = await resolveRules(tx, value.schedules);
    const sessions = generateSessions(value.startsOn, value.endsOn, rules);
    await assertTeacher(tx, value.teacherId);
    await assertClassSessions(tx, { ...value, ...(value.classId ? { id: value.classId } : {}), lifecycleStatus: 'open' }, sessions);
    return { timezone: 'Asia/Bangkok', schedules: rules, sessions, total: sessions.length };
  });
  res.json({ data: result });
});

router.get('/', async (req, res) => {
    const list = parseListQuery(req.query, ['id', 'name', 'capacity', 'createdAt']);
    const filters = [];
    if (list.search) filters.push(or(ilike(classes.name, `%${list.search}%`), ilike(subjects.name, `%${list.search}%`), ilike(subjects.code, `%${list.search}%`)));
    if (req.query.subject) filters.push(ilike(subjects.name, `%${String(req.query.subject).slice(0, 200).replace(/[%_]/g, '\\$&')}%`));
    if (req.query.teacher) filters.push(ilike(user.name, `%${String(req.query.teacher).slice(0, 200).replace(/[%_]/g, '\\$&')}%`));
    if (req.query.semester) filters.push(eq(classes.semesterId, z.coerce.number().int().positive().parse(req.query.semester)));
    if (req.query.department) filters.push(eq(subjects.departmentId, z.coerce.number().int().positive().parse(req.query.department)));
    if (req.query.status) filters.push(eq(classes.lifecycleStatus, lifecycle.parse(req.query.status)));
    const scope = z.enum(['all', 'mine', 'catalog']).default('all').parse(req.query.scope);
    const owned = classVisibility(req.user!, scope);
    if (owned) filters.push(owned);
    const where = filters.length ? and(...filters) : undefined;
    const sortColumns = { id: classes.id, name: classes.name, capacity: classes.capacity, createdAt: classes.createdAt } as const;
    const sort = list.order === 'asc' ? asc : desc;
    const [countResult, rows] = await Promise.all([
        db.select({ count: sql<number>`count(distinct ${classes.id})` }).from(classes)
        .leftJoin(subjects, eq(classes.subjectId, subjects.id)).leftJoin(user, eq(classes.teacherId, user.id)).where(where),
        db.select(classSelection).from(classes)
          .leftJoin(subjects, eq(classes.subjectId, subjects.id)).leftJoin(departments, eq(subjects.departmentId, departments.id))
          .leftJoin(user, eq(classes.teacherId, user.id)).where(where)
          .orderBy(sort(sortColumns[list.sort as keyof typeof sortColumns]), asc(classes.id)).limit(list.pageSize).offset(list.offset),
    ]);
    const total = Number(countResult[0]?.count ?? 0);
    const ids = rows.map(row => row.id);
    const scheduleRows = ids.length ? await db.select().from(classSchedules).where(inArray(classSchedules.classId, ids)) : [];
    const myEnrollments = ids.length && req.user!.role === 'student' ? await db.select().from(enrollments).where(and(inArray(enrollments.classId, ids), eq(enrollments.studentId, req.user!.id))) : [];
    res.json({ data: rows.map(row => ({ ...row, schedules: scheduleRows.filter(s => s.classId === row.id), enrollment: { status: myEnrollments.find(e => e.classId === row.id)?.status ?? null } })), pagination: pagination(total, list) });
});

router.get('/:id', async (req, res) => {
    const classId = z.coerce.number().int().positive().parse(req.params.id);
    const filters = [eq(classes.id, classId)];
    const owned = classVisibility(req.user!);
    if (owned) filters.push(owned);
    const [details] = await db.select(classSelection).from(classes)
        .leftJoin(subjects, eq(classes.subjectId, subjects.id)).leftJoin(departments, eq(subjects.departmentId, departments.id))
        .leftJoin(user, eq(classes.teacherId, user.id))
        .where(and(...filters)).limit(1);
    if (!details) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found', { classId });
    const scheduleRows = await db.select().from(classSchedules).where(eq(classSchedules.classId, classId));
    const [enrollment] = await db.select({ status: enrollments.status, registrationPeriodId: enrollments.registrationPeriodId, cancellationDeadline: registrationPeriods.cancellationDeadline }).from(enrollments).leftJoin(registrationPeriods, eq(registrationPeriods.id, enrollments.registrationPeriodId)).where(and(eq(enrollments.classId, classId), eq(enrollments.studentId, req.user!.id))).limit(1);
    const periods = await db.select({ id: registrationPeriods.id, name: registrationPeriods.name, opensAt: registrationPeriods.opensAt, closesAt: registrationPeriods.closesAt, cancellationDeadline: registrationPeriods.cancellationDeadline, status: registrationPeriods.status }).from(registrationPeriods).innerJoin(registrationPeriodClasses, eq(registrationPeriodClasses.periodId, registrationPeriods.id)).where(and(eq(registrationPeriodClasses.classId, classId), req.user!.role === 'admin' ? undefined : ne(registrationPeriods.status, 'draft')));
    const [teacherProfile] = await db.select({ teacherCode: teacherProfiles.teacherCode, academicDegree: teacherProfiles.academicDegree, specialization: teacherProfiles.specialization }).from(teacherProfiles).where(eq(teacherProfiles.userId, details.teacherId));
    res.json({ data: { ...details, teacherProfile: teacherProfile ?? null, registrationPeriods: periods, schedules: scheduleRows, enrollment: { status: enrollment?.status ?? null, registrationPeriodId: enrollment?.registrationPeriodId ?? null, cancellationDeadline: enrollment?.cancellationDeadline ?? null, enabled: req.user!.role === 'student' } } });
});

router.post('/', requireRole('admin'), async (req, res) => {
    const input = createClassSchema.parse(req.body);
    const created = await serializable(async (tx) => {
        await assertTeacher(tx, input.teacherId);
        const rules = await resolveRules(tx, input.schedules);
        if (!!input.startsOn !== !!input.endsOn || (rules.length && !input.startsOn)) throw new ApiError(400, 'CLASS_DATES_REQUIRED', 'Supply both class dates');
        const sessions = input.startsOn && input.endsOn && rules.length ? generateSessions(input.startsOn, input.endsOn, rules) : [];
        if (input.lifecycleStatus !== 'draft' && !sessions.length) throw new ApiError(409, 'SCHEDULE_REQUIRED', 'Set class dates and schedules before publishing');
        if (sessions.some(sessionStarted)) throw new ApiError(409, 'PAST_SESSION_IMMUTABLE', 'New classes cannot create sessions in the past');
        if (input.startsOn && input.endsOn) await assertClassSessions(tx, { ...input, startsOn: input.startsOn, endsOn: input.endsOn }, sessions);
        const [createdClass] = await tx.insert(classes).values({
            ...input, inviteCode: randomBytes(24).toString('base64url'), schedules: [], scheduleReviewRequired: !sessions.length,
        }).returning({ id: classes.id });
        if (!createdClass) throw new ApiError(500, 'CLASS_CREATE_FAILED', 'Class could not be created');
        if (rules.length) await tx.insert(classSchedules).values(rules.map(s => ({ ...s, classId: createdClass.id })));
        if (sessions.length) await tx.insert(classSessions).values(sessions.map(s => ({ ...s, classId: createdClass.id })));
        await writeAuditEvent(tx, {
            actorId: req.user!.id, entityType: 'class', entityId: String(createdClass.id),
            action: 'class.created', requestId: req.requestId,
            metadata: { subjectId: input.subjectId, teacherId: input.teacherId, capacity: input.capacity },
        });
        return createdClass;
    });
    res.status(201).json({ data: created });
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const classId = z.coerce.number().int().positive().parse(req.params.id); const patch = patchClassSchema.parse(req.body);
  if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_ERROR', 'At least one editable field is required');
  const updated = await serializable(async tx => {
    const [current] = await tx.select().from(classes).where(eq(classes.id, classId)).for('update');
    if (!current) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found', { classId });
    const currentSchedules = await tx.select().from(classSchedules).where(eq(classSchedules.classId, classId));
    const next = { ...current, teacherId: patch.teacherId ?? current.teacherId, subjectId: patch.subjectId ?? current.subjectId, semesterId: patch.semesterId ?? current.semesterId, startsOn: patch.startsOn ?? current.startsOn, endsOn: patch.endsOn ?? current.endsOn, lifecycleStatus: patch.lifecycleStatus ?? current.lifecycleStatus };
    if (!next.semesterId) throw new ApiError(400, 'SEMESTER_REQUIRED', 'Class must have a semester');
    assertTransition(current.lifecycleStatus, next.lifecycleStatus);
    if ((patch.subjectId !== undefined && patch.subjectId !== current.subjectId) || (patch.semesterId !== undefined && patch.semesterId !== current.semesterId)) {
      const duplicate = await tx.execute(sql`SELECT 1 FROM enrollments own
        JOIN enrollments other ON other.student_id=own.student_id AND other.status='active'
        JOIN classes sibling ON sibling.id=other.class_id
        WHERE own.class_id=${classId} AND own.status='active' AND sibling.id<>${classId}
          AND sibling.subject_id=${patch.subjectId ?? current.subjectId}
          AND sibling.semester_id=${next.semesterId} LIMIT 1`);
      if (duplicate.rows.length) throw new ApiError(409, 'SUBJECT_ALREADY_ENROLLED', 'A student is already enrolled in this subject for the semester');
    }
    if (current.lifecycleStatus === 'closed' && next.lifecycleStatus === 'open') {
      const window = await tx.execute(sql`SELECT 1 FROM semesters WHERE id=${next.semesterId} AND (now() AT TIME ZONE 'Asia/Bangkok')::date <= ends_on::date`);
      if (!window.rows.length) throw new ApiError(409, 'REGISTRATION_CLOSED', 'Semester has ended');
    }
    if (patch.semesterId && patch.semesterId !== current.semesterId) {
      const linked = await tx.execute(sql`SELECT 1 FROM registration_period_classes WHERE class_id=${classId} LIMIT 1`);
      if (linked.rows.length) throw new ApiError(409, 'CLASS_REGISTRATION_PERIOD_LINKED', 'Remove draft registration links before changing semester');
    }
    if ((patch.teacherId && patch.teacherId !== current.teacherId) || (next.lifecycleStatus === 'open' && !patch.archive)) await assertTeacher(tx, next.teacherId);
    const existingSessions = await tx.select().from(classSessions).where(eq(classSessions.classId, classId));
    const ruleKeys = (rows: { dayOfWeek: number; timeSlotId: number | null }[]) => rows.map(r => `${r.dayOfWeek}:${r.timeSlotId}`).sort();
    const ruleChanged = patch.schedules !== undefined && JSON.stringify(ruleKeys(patch.schedules)) !== JSON.stringify(ruleKeys(currentSchedules));
    const replace = ruleChanged || next.startsOn !== current.startsOn || next.endsOn !== current.endsOn;
    if ((replace || next.teacherId !== current.teacherId || next.subjectId !== current.subjectId || next.semesterId !== current.semesterId) && existingSessions.some(sessionStarted)) throw new ApiError(409, 'PAST_SESSION_IMMUTABLE', 'Past sessions and their assignment cannot be rewritten');
    if (replace && existingSessions.some(s => s.source === 'manual' || s.status === 'cancelled')) throw new ApiError(409, 'SCHEDULE_HAS_EXCEPTIONS', 'Edit individual sessions to preserve cancellations and reschedules');
    const rules = ruleChanged && patch.schedules ? await resolveRules(tx, patch.schedules) : currentSchedules;
    let sessions: SessionInput[] = existingSessions;
    if (replace) {
      if (!next.startsOn || !next.endsOn || rules.some(r => r.timeSlotId === null)) throw new ApiError(400, 'CLASS_DATES_REQUIRED', 'Supply class dates and valid time slots');
      sessions = rules.length ? generateSessions(next.startsOn, next.endsOn, rules as import('../services/class-schedule.js').ScheduleInput[]) : [];
      if (sessions.some(sessionStarted)) throw new ApiError(409, 'PAST_SESSION_IMMUTABLE', 'Cannot generate past sessions');
    }
    if (next.lifecycleStatus === 'open' && !patch.archive && (!next.startsOn || !next.endsOn || !sessions.length)) throw new ApiError(409, 'SCHEDULE_REQUIRED', 'Set class dates and sessions before publishing');
    if (next.startsOn && next.endsOn) await assertClassSessions(tx, { ...next, startsOn: next.startsOn, endsOn: next.endsOn, semesterId: next.semesterId, archivedAt: patch.archive ? new Date() : current.archivedAt }, sessions);
    if (patch.capacity !== undefined) { const [count] = await tx.select({ count: sql<number>`count(*)` }).from(enrollments).where(and(eq(enrollments.classId, classId), eq(enrollments.status, 'active'))); if (Number(count?.count ?? 0) > patch.capacity) throw new ApiError(409, 'CAPACITY_BELOW_ACTIVE_ENROLLMENT', 'Capacity cannot be below active enrollment', { activeEnrollment: Number(count?.count ?? 0) }); }
    const values = { ...patch, scheduleReviewRequired: !sessions.length, archivedAt: patch.archive ? new Date() : current.archivedAt, archivedBy: patch.archive ? req.user!.id : current.archivedBy };
    delete (values as { schedules?: unknown }).schedules; delete (values as { archive?: unknown }).archive;
    const [row] = await tx.update(classes).set(values).where(eq(classes.id, classId)).returning({ id: classes.id });
    if (ruleChanged) { await tx.delete(classSchedules).where(eq(classSchedules.classId, classId)); if (rules.length) await tx.insert(classSchedules).values(rules.map(s => ({ classId, dayOfWeek: s.dayOfWeek, timeSlotId: s.timeSlotId, startTime: s.startTime, endTime: s.endTime }))); }
    if (replace) { await tx.delete(classSessions).where(eq(classSessions.classId, classId)); if (sessions.length) await tx.insert(classSessions).values(sessions.map(s => ({ ...s, classId }))); }
    await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'class', entityId: String(classId), action: patch.archive ? 'class.archived' : 'class.updated', requestId: req.requestId, metadata: { changed: Object.keys(patch), ...(replace ? { scheduleBefore: existingSessions, scheduleAfter: sessions } : {}) } }); return row;
  }); res.json({ data: updated });
});

export default router;
