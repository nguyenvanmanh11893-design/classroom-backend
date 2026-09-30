import { Router } from 'express';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { classes, registrationPeriodClasses, registrationPeriods, semesters } from '../db/schema/app.js';
import { requireRole } from '../middleware/auth.js';
import { ApiError } from '../lib/api-error.js';
import { parseListQuery, pagination } from '../lib/list-query.js';
import { serializable, type Tx } from '../services/transaction.js';
import { writeAuditEvent } from '../services/audit.js';

const router = Router();
const instant = z.string().datetime({ offset: true }).transform(v => new Date(v));
const fields = z.object({ semesterId: z.number().int().positive(), name: z.string().trim().min(1).max(200), opensAt: instant, closesAt: instant, cancellationDeadline: instant, status: z.enum(['draft', 'open', 'closed']), classIds: z.array(z.number().int().positive()).max(1000).refine(v => new Set(v).size === v.length) }).strict();
type PeriodValue = z.infer<typeof fields>;
async function validate(tx: Tx, value: PeriodValue) {
  if (value.opensAt >= value.closesAt || value.cancellationDeadline < value.closesAt) throw new ApiError(400, 'REGISTRATION_DATE_RANGE_INVALID', 'Opening must precede closing; cancellation deadline must not precede closing');
  const [semester] = await tx.select().from(semesters).where(eq(semesters.id, value.semesterId));
  if (!semester) throw new ApiError(400, 'SEMESTER_NOT_FOUND', 'Semester was not found');
  const rows = value.classIds.length ? await tx.select().from(classes).where(inArray(classes.id, value.classIds)).orderBy(asc(classes.id)).for('update') : [];
  if (rows.length !== value.classIds.length || rows.some(c => c.semesterId !== value.semesterId)) throw new ApiError(400, 'REGISTRATION_CLASSES_INVALID', 'Every section must belong to this semester');
  if (value.status !== 'open') return;
  if (semester.status !== 'active' || !rows.length) throw new ApiError(409, 'REGISTRATION_NOT_READY', 'An open period needs an active semester and at least one class');
  for (const row of rows) {
    if (row.lifecycleStatus !== 'open' || row.archivedAt || row.scheduleReviewRequired) throw new ApiError(409, 'REGISTRATION_NOT_READY', 'Publish and review each class schedule first', { classId: row.id });
    const sessions = await tx.execute(sql`SELECT min((session_date+start_time::time) AT TIME ZONE 'Asia/Bangkok') AS first FROM class_sessions WHERE class_id=${row.id} AND status='scheduled'`);
    const first = sessions.rows[0]?.first;
    if (!first || value.closesAt > new Date(String(first))) throw new ApiError(409, 'REGISTRATION_AFTER_CLASS_START', 'Registration must close before the first class session', { classId: row.id });
  }
}
router.get('/', async (req, res) => {
  const q = parseListQuery(req.query, ['opensAt'], 'opensAt');
  const where = and(req.user!.role === 'admin' ? undefined : ne(registrationPeriods.status, 'draft'), req.query.semester ? eq(registrationPeriods.semesterId, z.coerce.number().int().positive().parse(req.query.semester)) : undefined);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(registrationPeriods).where(where);
  const rows = await db.select().from(registrationPeriods).where(where).orderBy(asc(registrationPeriods.opensAt), asc(registrationPeriods.id)).limit(q.pageSize).offset(q.offset);
  const links = rows.length ? await db.select().from(registrationPeriodClasses).where(inArray(registrationPeriodClasses.periodId, rows.map(r => r.id))) : [];
  res.json({ data: rows.map(r => ({ ...r, classIds: links.filter(l => l.periodId === r.id).map(l => l.classId) })), pagination: pagination(count?.n ?? 0, q) });
});
router.get('/:id', async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const [row] = await db.select().from(registrationPeriods).where(and(eq(registrationPeriods.id, id), req.user!.role === 'admin' ? undefined : ne(registrationPeriods.status, 'draft')));
  if (!row) throw new ApiError(404, 'REGISTRATION_PERIOD_NOT_FOUND', 'Registration period was not found');
  const links = await db.select().from(registrationPeriodClasses).where(eq(registrationPeriodClasses.periodId, id));
  res.json({ data: { ...row, classIds: links.map(l => l.classId) } });
});
router.post('/', requireRole('admin'), async (req, res) => {
  const value = fields.parse(req.body);
  const data = await serializable(async tx => {
    await validate(tx, value);
    const { classIds, ...input } = value;
    const [row] = await tx.insert(registrationPeriods).values(input).returning();
    if (classIds.length) await tx.insert(registrationPeriodClasses).values(classIds.map(classId => ({ periodId: row!.id, classId })));
    await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'registration_period', entityId: String(row!.id), action: 'registration_period.created', requestId: req.requestId });
    return { ...row!, classIds };
  });
  res.status(201).json({ data });
});
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const patch = fields.partial().parse(req.body);
  if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_ERROR', 'At least one editable field is required');
  const data = await serializable(async tx => {
    const [current] = await tx.select().from(registrationPeriods).where(eq(registrationPeriods.id, id)).for('update');
    if (!current) throw new ApiError(404, 'REGISTRATION_PERIOD_NOT_FOUND', 'Registration period was not found');
    const links = await tx.select().from(registrationPeriodClasses).where(eq(registrationPeriodClasses.periodId, id));
    const value = { ...current, classIds: links.map(l => l.classId), ...patch } as PeriodValue;
    if (current.status !== 'draft' && value.status === 'draft') throw new ApiError(409, 'REGISTRATION_TRANSITION_INVALID', 'A published period cannot return to draft');
    const used = await tx.execute(sql`SELECT DISTINCT class_id FROM enrollment_events WHERE registration_period_id=${id}`);
    if (used.rows.length && (value.semesterId !== current.semesterId || used.rows.some(r => !value.classIds.includes(Number(r.class_id))) || value.cancellationDeadline < current.cancellationDeadline)) throw new ApiError(409, 'REGISTRATION_PERIOD_IN_USE', 'Keep registered classes, semester and existing cancellation rights');
    await validate(tx, value);
    const { classIds, ...input } = patch;
    const [row] = await tx.update(registrationPeriods).set({ ...input, updatedAt: new Date() }).where(eq(registrationPeriods.id, id)).returning();
    if (classIds) {
      await tx.delete(registrationPeriodClasses).where(eq(registrationPeriodClasses.periodId, id));
      if (classIds.length) await tx.insert(registrationPeriodClasses).values(classIds.map(classId => ({ periodId: id, classId })));
    }
    await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'registration_period', entityId: String(id), action: 'registration_period.updated', requestId: req.requestId });
    return { ...row!, classIds: value.classIds };
  });
  res.json({ data });
});
export default router;
