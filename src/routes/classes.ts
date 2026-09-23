import { randomBytes } from 'node:crypto';
import express from 'express';
import { and, asc, desc, eq, exists, ilike, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { classes, classSchedules, departments, enrollments, semesters, subjects } from '../db/schema/app.js';
import { user } from '../db/schema/auth.js';
import { ApiError } from '../lib/api-error.js';
import { pagination, parseListQuery } from '../lib/list-query.js';
import { requireRole } from '../middleware/auth.js';
import { writeAuditEvent } from '../services/audit.js';
import { serializable } from '../services/transaction.js';
import { assertClassSchedule } from '../services/class-schedule.js';

const router = express.Router();

function ownershipCondition(currentUser: NonNullable<Express.Request['user']>) {
    if (currentUser.role === 'admin') return undefined;
    if (currentUser.role === 'teacher') return eq(classes.teacherId, currentUser.id);
    return exists(db.select({ value: sql`1` }).from(enrollments).where(and(
        eq(enrollments.classId, classes.id),
        eq(enrollments.studentId, currentUser.id),
    )));
}

const classSelection = {
    id: classes.id, name: classes.name, description: classes.description, status: classes.status,
    semesterId: classes.semesterId, teacherId: classes.teacherId, subjectId: classes.subjectId,
    activeEnrollmentCount: sql<number>`(SELECT count(*)::int FROM enrollments e WHERE e.class_id=classes.id AND e.status='active')`,
    capacity: classes.capacity, bannerUrl: classes.bannerUrl, bannerCldPubId: classes.bannerCldPubId,
    lifecycleStatus: classes.lifecycleStatus, archivedAt: classes.archivedAt, createdAt: classes.createdAt, updatedAt: classes.updatedAt,
    subject: { id: subjects.id, name: subjects.name, code: subjects.code, description: subjects.description },
    department: { id: departments.id, name: departments.name, code: departments.code, description: departments.description },
    teacher: { id: user.id, name: user.name, image: user.image },
};

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const scheduleInput = z.object({ dayOfWeek: z.coerce.number().int().min(1).max(7), startTime: time, endTime: time }).strict().refine(v => v.startTime < v.endTime, { message: 'End time must follow start time', path: ['endTime'] });
const lifecycle = z.enum(['draft', 'open', 'closed', 'completed', 'cancelled']);
const inputFields = z.object({ subjectId: z.coerce.number().int().positive(), semesterId: z.coerce.number().int().positive(), teacherId: z.string().min(1).max(200), name: z.string().trim().min(2).max(255), bannerCldPubId: z.string().max(500).optional(), bannerUrl: z.url().max(2000).optional(), description: z.string().max(5000).optional(), capacity: z.coerce.number().int().positive().max(100000), lifecycleStatus: lifecycle, schedules: z.array(scheduleInput).max(14) }).strict();
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
}

router.get('/', async (req, res) => {
    const list = parseListQuery(req.query, ['id', 'name', 'capacity', 'createdAt']);
    const filters = [];
    if (list.search) filters.push(ilike(classes.name, `%${list.search}%`));
    if (req.query.subject) filters.push(ilike(subjects.name, `%${String(req.query.subject).slice(0, 200).replace(/[%_]/g, '\\$&')}%`));
    if (req.query.teacher) filters.push(ilike(user.name, `%${String(req.query.teacher).slice(0, 200).replace(/[%_]/g, '\\$&')}%`));
    if (req.query.semester) filters.push(eq(classes.semesterId, z.coerce.number().int().positive().parse(req.query.semester)));
    if (req.query.department) filters.push(eq(subjects.departmentId, z.coerce.number().int().positive().parse(req.query.department)));
    if (req.query.status) filters.push(eq(classes.lifecycleStatus, lifecycle.parse(req.query.status)));
    const owned = ownershipCondition(req.user!);
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
    res.json({ data: rows.map(row => ({ ...row, schedules: scheduleRows.filter(s => s.classId === row.id) })), pagination: pagination(total, list) });
});

router.get('/:id', async (req, res) => {
    const classId = z.coerce.number().int().positive().parse(req.params.id);
    const filters = [eq(classes.id, classId)];
    const owned = ownershipCondition(req.user!);
    if (owned) filters.push(owned);
    const [details] = await db.select(classSelection).from(classes)
        .leftJoin(subjects, eq(classes.subjectId, subjects.id)).leftJoin(departments, eq(subjects.departmentId, departments.id))
        .leftJoin(user, eq(classes.teacherId, user.id))
        .where(and(...filters)).limit(1);
    if (!details) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found', { classId });
    const scheduleRows = await db.select().from(classSchedules).where(eq(classSchedules.classId, classId));
    const [enrollment] = await db.select({ status: enrollments.status }).from(enrollments).where(and(eq(enrollments.classId, classId), eq(enrollments.studentId, req.user!.id))).limit(1);
    res.json({ data: { ...details, schedules: scheduleRows, enrollment: { status: enrollment?.status ?? null, enabled: req.user!.role === 'student' } } });
});

router.post('/', requireRole('admin'), async (req, res) => {
    const input = createClassSchema.parse(req.body);
    const created = await serializable(async (tx) => {
        await assertTeacher(tx, input.teacherId); await assertClassSchedule(tx, undefined, input.teacherId, input.semesterId, input.schedules, !['cancelled', 'completed'].includes(input.lifecycleStatus));
        const [createdClass] = await tx.insert(classes).values({
            ...input, inviteCode: randomBytes(24).toString('base64url'), schedules: [],
        }).returning({ id: classes.id });
        if (!createdClass) throw new ApiError(500, 'CLASS_CREATE_FAILED', 'Class could not be created');
        if (input.schedules.length) await tx.insert(classSchedules).values(input.schedules.map(s => ({ ...s, classId: createdClass.id })));
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
  const updated = await serializable(async tx => {
    const [current] = await tx.select().from(classes).where(eq(classes.id, classId)).for('update');
    if (!current) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found', { classId });
    const currentSchedules = await tx.select().from(classSchedules).where(eq(classSchedules.classId, classId));
    const next = { teacherId: patch.teacherId ?? current.teacherId, semesterId: patch.semesterId ?? current.semesterId, schedules: patch.schedules ?? currentSchedules, lifecycleStatus: patch.lifecycleStatus ?? current.lifecycleStatus };
    if (!next.semesterId) throw new ApiError(400, 'SEMESTER_REQUIRED', 'Class must have a semester');
    assertTransition(current.lifecycleStatus, next.lifecycleStatus);
    if (current.lifecycleStatus === 'closed' && next.lifecycleStatus === 'open') {
      const window = await tx.execute(sql`SELECT 1 FROM semesters WHERE id=${next.semesterId} AND (now() AT TIME ZONE 'Asia/Bangkok')::date <= ends_on::date`);
      if (!window.rows.length) throw new ApiError(409, 'REGISTRATION_CLOSED', 'Semester has ended');
    }
    await assertTeacher(tx, next.teacherId); await assertClassSchedule(tx, classId, next.teacherId, next.semesterId, next.schedules, !current.archivedAt && !patch.archive && !['cancelled', 'completed'].includes(next.lifecycleStatus));
    if (patch.capacity !== undefined) { const [count] = await tx.select({ count: sql<number>`count(*)` }).from(enrollments).where(and(eq(enrollments.classId, classId), eq(enrollments.status, 'active'))); if (Number(count?.count ?? 0) > patch.capacity) throw new ApiError(409, 'CAPACITY_BELOW_ACTIVE_ENROLLMENT', 'Capacity cannot be below active enrollment', { activeEnrollment: Number(count?.count ?? 0) }); }
    const values = { ...patch, archivedAt: patch.archive ? new Date() : current.archivedAt, archivedBy: patch.archive ? req.user!.id : current.archivedBy };
    delete (values as { schedules?: unknown }).schedules; delete (values as { archive?: unknown }).archive;
    const [row] = await tx.update(classes).set(values).where(eq(classes.id, classId)).returning({ id: classes.id });
    if (patch.schedules) { await tx.delete(classSchedules).where(eq(classSchedules.classId, classId)); if (patch.schedules.length) await tx.insert(classSchedules).values(patch.schedules.map(s => ({ ...s, classId }))); }
    await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'class', entityId: String(classId), action: patch.archive ? 'class.archived' : 'class.updated', requestId: req.requestId, metadata: { changed: Object.keys(patch) } }); return row;
  }); res.json({ data: updated });
});

export default router;
