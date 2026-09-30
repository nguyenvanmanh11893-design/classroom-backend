import { Router } from 'express';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { classes, classSessions, subjects, timeSlots } from '../db/schema/app.js';
import { requireRole } from '../middleware/auth.js';
import { ApiError } from '../lib/api-error.js';
import { calendarDate } from '../lib/calendar.js';
import { pagination, parseListQuery } from '../lib/list-query.js';
import { serializable } from '../services/transaction.js';
import { assertClassSessions, sessionStarted } from '../services/class-schedule.js';
import { classVisibility, visibleClass } from '../services/class-access.js';
import { writeAuditEvent } from '../services/audit.js';

const router = Router();
const id = z.coerce.number().int().positive();
const fields = z.object({ sessionDate: calendarDate, timeSlotId: z.number().int().positive(), status: z.enum(['scheduled', 'cancelled']), note: z.string().trim().min(1).max(1000) }).strict();
router.get('/classes/:id/sessions', async (req, res) => {
  const classId = id.parse(req.params.id); await visibleClass(classId, req.user!);
  const q = parseListQuery(req.query, ['sessionDate'], 'sessionDate');
  const where = and(eq(classSessions.classId, classId), req.query.from ? gte(classSessions.sessionDate, calendarDate.parse(req.query.from)) : undefined, req.query.to ? lte(classSessions.sessionDate, calendarDate.parse(req.query.to)) : undefined);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(classSessions).where(where);
  res.json({ data: await db.select().from(classSessions).where(where).orderBy(asc(classSessions.sessionDate), asc(classSessions.startTime), asc(classSessions.id)).limit(q.pageSize).offset(q.offset), pagination: pagination(count?.n ?? 0, q), timezone: 'Asia/Bangkok' });
});
router.get('/timetable', async (req, res) => {
  const from = calendarDate.parse(req.query.from), to = calendarDate.parse(req.query.to);
  if (from > to || Date.parse(to) - Date.parse(from) > 93 * 86400000) throw new ApiError(400, 'DATE_RANGE_INVALID', 'Request a timetable range of at most 93 days');
  const q = parseListQuery(req.query, ['sessionDate'], 'sessionDate');
  const where = and(classVisibility(req.user!, 'mine'), gte(classSessions.sessionDate, from), lte(classSessions.sessionDate, to), sql`${classes.archivedAt} IS NULL AND ${classes.lifecycleStatus} NOT IN ('cancelled','completed')`);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(classSessions).innerJoin(classes, eq(classes.id, classSessions.classId)).where(where);
  const rows = await db.select({ session: classSessions, classId: classes.id, className: classes.name, subjectName: subjects.name, teacherId: classes.teacherId }).from(classSessions).innerJoin(classes, eq(classes.id, classSessions.classId)).innerJoin(subjects, eq(subjects.id, classes.subjectId)).where(where).orderBy(asc(classSessions.sessionDate), asc(classSessions.startTime), asc(classSessions.id)).limit(q.pageSize).offset(q.offset);
  res.json({ data: rows, pagination: pagination(count?.n ?? 0, q), timezone: 'Asia/Bangkok' });
});
for (const method of ['post', 'patch'] as const) {
  router[method](method === 'post' ? '/classes/:id/sessions' : '/classes/:id/sessions/:sessionId', requireRole('admin'), async (req, res) => {
    const classId = id.parse(req.params.id), sessionId = method === 'patch' ? id.parse(req.params.sessionId) : undefined;
    const patch = method === 'post' ? fields.extend({ status: fields.shape.status.default('scheduled') }).parse(req.body) : fields.partial().extend({ note: fields.shape.note }).parse(req.body);
    const data = await serializable(async tx => {
      const [classroom] = await tx.select().from(classes).where(eq(classes.id, classId)).for('update');
      if (!classroom) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found');
      if (!classroom.startsOn || !classroom.endsOn || !classroom.semesterId || classroom.scheduleReviewRequired) throw new ApiError(409, 'SCHEDULE_REQUIRED', 'Confirm class dates and recurring schedule first');
      if (classroom.archivedAt || ['cancelled', 'completed'].includes(classroom.lifecycleStatus)) throw new ApiError(409, 'CLASS_NOT_EDITABLE', 'This class is no longer editable');
      const sessions = await tx.select().from(classSessions).where(eq(classSessions.classId, classId));
      const current = sessionId ? sessions.find(s => s.id === sessionId) : undefined;
      if (sessionId && !current) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session was not found');
      if (current && sessionStarted(current)) throw new ApiError(409, 'PAST_SESSION_IMMUTABLE', 'Past or ongoing sessions cannot be changed');
      const slotId = patch.timeSlotId ?? current!.timeSlotId;
      const [slot] = await tx.select().from(timeSlots).where(eq(timeSlots.id, slotId));
      if (!slot || (!slot.isActive && (!current || slotId !== current.timeSlotId))) throw new ApiError(400, 'TIME_SLOT_INVALID', 'Choose an active time slot');
      const value = { classId, sessionDate: patch.sessionDate ?? current!.sessionDate, timeSlotId: slotId, startTime: slot.startTime, endTime: slot.endTime, status: patch.status ?? current?.status ?? 'scheduled', note: patch.note, source: 'manual' };
      if (sessionStarted(value)) throw new ApiError(409, 'PAST_SESSION_IMMUTABLE', 'Cannot create or move a session into the past');
      await assertClassSessions(tx, { ...classroom, startsOn: classroom.startsOn, endsOn: classroom.endsOn, semesterId: classroom.semesterId }, [...sessions.filter(s => s.id !== sessionId), value]);
      const [row] = sessionId ? await tx.update(classSessions).set(value).where(eq(classSessions.id, sessionId)).returning() : await tx.insert(classSessions).values(value).returning();
      await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'class_session', entityId: String(row!.id), action: current ? 'session.updated' : 'session.created', requestId: req.requestId, metadata: { before: current ?? null, after: row! } });
      return row;
    });
    res.status(method === 'post' ? 201 : 200).json({ data });
  });
}
export default router;
