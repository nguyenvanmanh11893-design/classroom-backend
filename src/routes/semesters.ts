import express from 'express';
import { and, asc, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { classes, semesters } from '../db/schema/app.js';
import { ApiError } from '../lib/api-error.js';
import { calendarDate } from '../lib/calendar.js';
import { pagination, parseListQuery } from '../lib/list-query.js';
import { requireRole } from '../middleware/auth.js';
import { serializable } from '../services/transaction.js';
import { assertStoredClassSchedule } from '../services/class-schedule.js';

const router = express.Router();
const date = calendarDate.transform(v => new Date(`${v}T00:00:00Z`));
const semesterFields = z.object({ code: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(255), startsOn: date, endsOn: date, status: z.enum(['draft','active','archived']).optional() }).strict();
export const semesterInput = semesterFields.refine(v => v.startsOn <= v.endsOn, { path: ['endsOn'], message: 'End must follow start' });
export const semesterPatchInput = semesterFields.partial();
const id = (v: unknown) => z.coerce.number().int().positive().parse(v);
const selection = { id: semesters.id, code: semesters.code, name: semesters.name, startsOn: semesters.startsOn, endsOn: semesters.endsOn, status: semesters.status, createdAt: semesters.createdAt, updatedAt: semesters.updatedAt };
router.get('/', async (req, res) => {
  const q = parseListQuery(req.query, ['id','code','name','startsOn','endsOn','createdAt']);
  const where = and(q.search ? ilike(semesters.name, `%${q.search}%`) : undefined, req.query.from ? gte(semesters.endsOn, date.parse(req.query.from)) : undefined, req.query.to ? lte(semesters.startsOn, date.parse(req.query.to)) : undefined);
  const cols = { id: semesters.id, code: semesters.code, name: semesters.name, startsOn: semesters.startsOn, endsOn: semesters.endsOn, createdAt: semesters.createdAt } as const;
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(semesters).where(where);
  const data = await db.select(selection).from(semesters).where(where).orderBy((q.order === 'asc' ? asc : desc)(cols[q.sort as keyof typeof cols]), asc(semesters.id)).limit(q.pageSize).offset(q.offset);
  res.json({ data, pagination: pagination(count?.n ?? 0, q) });
});
router.get('/:id', async (req, res) => {
  const [row] = await db.select(selection).from(semesters).where(eq(semesters.id, id(req.params.id)));
  if (!row) throw new ApiError(404, 'SEMESTER_NOT_FOUND', 'Semester was not found');
  res.json({ data: row });
});
router.post('/', requireRole('admin'), async (req, res) => {
  const [row] = await db.insert(semesters).values(semesterInput.parse(req.body)).returning(selection);
  res.status(201).json({ data: row });
});
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const semesterId = id(req.params.id), patch = semesterPatchInput.parse(req.body);
  if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_ERROR', 'At least one editable field is required');
  const data = await serializable(async tx => {
    const [current] = await tx.select().from(semesters).where(eq(semesters.id, semesterId)).for('update');
    if (!current) throw new ApiError(404, 'SEMESTER_NOT_FOUND', 'Semester was not found');
    if ((patch.startsOn ?? current.startsOn) > (patch.endsOn ?? current.endsOn)) throw new ApiError(400, 'DATE_RANGE_INVALID', 'End must follow start');
    const [row] = await tx.update(semesters).set(patch).where(eq(semesters.id, semesterId)).returning(selection);
    if (patch.startsOn || patch.endsOn) {
      const affected = await tx.select({ id: classes.id }).from(classes).where(eq(classes.semesterId, semesterId));
      for (const c of affected) await assertStoredClassSchedule(tx, c.id);
    }
    return row;
  });
  res.json({ data });
});
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const [row] = await db.delete(semesters).where(eq(semesters.id, id(req.params.id))).returning({ id: semesters.id });
  if (!row) throw new ApiError(404, 'SEMESTER_NOT_FOUND', 'Semester was not found');
  res.status(204).end();
});
export default router;
