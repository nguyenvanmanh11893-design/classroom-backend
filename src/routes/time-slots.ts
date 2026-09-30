import { Router } from 'express';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { timeSlots } from '../db/schema/app.js';
import { requireRole } from '../middleware/auth.js';
import { ApiError } from '../lib/api-error.js';
import { serializable } from '../services/transaction.js';
import { writeAuditEvent } from '../services/audit.js';
import { pagination, parseListQuery } from '../lib/list-query.js';
const router = Router();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const fields = z.object({ name: z.string().trim().min(1).max(100), startTime: time, endTime: time, isActive: z.boolean() }).strict();
const input = fields.extend({ isActive: z.boolean().default(true) }).refine(v => v.startTime < v.endTime, { path: ['endTime'], message: 'End must follow start' });
router.get('/', async (req, res) => {
  const q = parseListQuery(req.query, ['startTime'], 'startTime');
  const where = req.user!.role === 'admin' ? undefined : eq(timeSlots.isActive, true);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(timeSlots).where(where);
  res.json({ data: await db.select().from(timeSlots).where(where).orderBy(asc(timeSlots.startTime), asc(timeSlots.id)).limit(q.pageSize).offset(q.offset), pagination: pagination(count?.n ?? 0, q) });
});
router.post('/', requireRole('admin'), async (req, res) => {
  const value = input.parse(req.body);
  const data = await serializable(async tx => {
    const [row] = await tx.insert(timeSlots).values(value).returning();
    await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'time_slot', entityId: String(row!.id), action: 'time_slot.created', requestId: req.requestId });
    return row;
  });
  res.status(201).json({ data });
});
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const patch = fields.partial().parse(req.body);
  if (!Object.keys(patch).length) throw new ApiError(400, 'VALIDATION_ERROR', 'At least one editable field is required');
  const data = await serializable(async tx => {
    const [row] = await tx.select().from(timeSlots).where(eq(timeSlots.id, id)).for('update');
    if (!row) throw new ApiError(404, 'TIME_SLOT_NOT_FOUND', 'Time slot was not found');
    input.parse({ name: row.name, startTime: row.startTime, endTime: row.endTime, isActive: row.isActive, ...patch });
    if ((patch.startTime && patch.startTime !== row.startTime) || (patch.endTime && patch.endTime !== row.endTime)) {
      const used = await tx.execute(sql`SELECT 1 FROM class_schedules WHERE time_slot_id=${id} UNION ALL SELECT 1 FROM class_sessions WHERE time_slot_id=${id} LIMIT 1`);
      if (used.rows.length) throw new ApiError(409, 'TIME_SLOT_IN_USE', 'Create a new time slot to preserve existing schedules');
    }
    const [updated] = await tx.update(timeSlots).set(patch).where(eq(timeSlots.id, id)).returning();
    await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'time_slot', entityId: String(id), action: 'time_slot.updated', requestId: req.requestId });
    return updated;
  });
  res.json({ data });
});
export default router;
