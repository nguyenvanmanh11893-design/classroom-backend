import { Router } from 'express';
import { and, asc, eq, ilike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { classes, classInvites, enrollments } from '../db/schema/app.js';
import { user } from '../db/schema/auth.js';
import { db } from '../db/index.js';
import { ApiError } from '../lib/api-error.js';
import { requireRole } from '../middleware/auth.js';
import { enroll, hashCode, newInviteCode, unenroll } from '../services/enrollment.js';

const router = Router();
const inviteAttempts = new Map<string, { count: number; reset: number }>();
const enrollmentInput = z.object({ studentId: z.string().min(1).max(200), inviteCode: z.string().min(20).max(200).optional() }).strict();
const inviteInput = z.object({ expiresAt: z.coerce.date().optional(), maxUses: z.coerce.number().int().positive().max(100000).optional() }).strict();
async function manageClass(classId: number, actor: Express.Request['user']) {
  const [row] = await db.select({ teacherId: classes.teacherId }).from(classes).where(eq(classes.id, classId));
  if (!row) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found');
  if (actor!.role !== 'admin' && row.teacherId !== actor!.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action');
}
function inviteRateLimit(actorId: string) {
  const now = Date.now(), current = inviteAttempts.get(actorId);
  if (!current || current.reset < now) { inviteAttempts.set(actorId, { count: 1, reset: now + 60_000 }); return; }
  if (++current.count > 10) throw new ApiError(429, 'INVITE_RATE_LIMITED', 'Too many invite attempts');
}

router.post('/classes/:id/enrollments', async (req, res) => {
  const classId = z.coerce.number().int().positive().parse(req.params.id); const body = enrollmentInput.parse(req.body);
  if (req.user!.role === 'teacher') throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action');
  if (req.user!.role === 'student' && body.studentId !== req.user!.id) throw new ApiError(403, 'ENROLLMENT_SELF_ONLY', 'Students may only enroll themselves');
  if (body.inviteCode) inviteRateLimit(req.user!.id);
  const data = await enroll({ classId, studentId: body.studentId, actorId: req.user!.id, source: body.inviteCode ? 'invite' : req.user!.role === 'admin' ? 'admin' : 'student', ...(body.inviteCode ? { inviteCode: body.inviteCode } : {}), requestId: req.requestId });
  res.status(201).json({ data });
});

router.delete('/classes/:id/enrollments/:studentId', async (req, res) => {
  const classId = z.coerce.number().int().positive().parse(req.params.id); const studentId = z.string().min(1).max(200).parse(req.params.studentId);
  if (req.user!.role === 'teacher') throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action');
  if (req.user!.role === 'student' && studentId !== req.user!.id) throw new ApiError(403, 'ENROLLMENT_SELF_ONLY', 'Students may only cancel their own enrollment');
  res.json({ data: await unenroll({ classId, studentId, actorId: req.user!.id, requestId: req.requestId }) });
});

router.get('/classes/:id/roster', async (req, res) => {
  const classId = z.coerce.number().int().positive().parse(req.params.id);
  if (req.user!.role === 'student') { const [mine] = await db.select({ status: enrollments.status }).from(enrollments).where(and(eq(enrollments.classId, classId), eq(enrollments.studentId, req.user!.id))); return res.json({ data: mine ? [{ studentId: req.user!.id, status: mine.status }] : [] }); }
  await manageClass(classId, req.user);
  const page = Math.max(1, Number(req.query.page ?? 1)); const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20))); const search = String(req.query.search ?? '').slice(0, 200);
  const where = search ? and(eq(enrollments.classId, classId), ilike(user.name, `%${search.replace(/[%_]/g, '\\$&')}%`)) : eq(enrollments.classId, classId);
  const [count, rows] = await Promise.all([db.select({ count: sql<number>`count(*)` }).from(enrollments).innerJoin(user, eq(user.id, enrollments.studentId)).where(where), db.select({ studentId: user.id, name: user.name, status: enrollments.status, enrolledAt: enrollments.enrolledAt }).from(enrollments).innerJoin(user, eq(user.id, enrollments.studentId)).where(where).orderBy(asc(user.name), asc(user.id)).limit(limit).offset((page - 1) * limit)]);
  res.json({ data: rows, pagination: { page, limit, total: Number(count[0]?.count ?? 0), totalPages: Math.ceil(Number(count[0]?.count ?? 0) / limit) } });
});

router.post('/classes/:id/invites', async (req, res) => {
  const classId = z.coerce.number().int().positive().parse(req.params.id); await manageClass(classId, req.user); const input = inviteInput.parse(req.body); if (input.expiresAt && input.expiresAt <= new Date()) throw new ApiError(400, 'INVITE_EXPIRY_INVALID', 'Invite expiry must be in the future');
  const code = newInviteCode(); const [invite] = await db.insert(classInvites).values({ classId, codeHash: hashCode(code), expiresAt: input.expiresAt, maxUses: input.maxUses, createdBy: req.user!.id }).returning({ id: classInvites.id, expiresAt: classInvites.expiresAt, maxUses: classInvites.maxUses });
  res.status(201).json({ data: { ...invite, code } });
});
router.post('/classes/:id/invites/:inviteId/revoke', async (req, res) => { const classId = z.coerce.number().int().positive().parse(req.params.id); await manageClass(classId, req.user); await db.update(classInvites).set({ revokedAt: new Date() }).where(and(eq(classInvites.id, req.params.inviteId), eq(classInvites.classId, classId))); res.json({ data: { revoked: true } }); });
router.post('/classes/:id/invites/:inviteId/rotate', async (req, res) => { const classId = z.coerce.number().int().positive().parse(req.params.id); await manageClass(classId, req.user); await db.update(classInvites).set({ revokedAt: new Date() }).where(and(eq(classInvites.id, req.params.inviteId), eq(classInvites.classId, classId))); const code = newInviteCode(); const [invite] = await db.insert(classInvites).values({ classId, codeHash: hashCode(code), createdBy: req.user!.id }).returning({ id: classInvites.id }); res.status(201).json({ data: { ...invite, code } }); });
export default router;
