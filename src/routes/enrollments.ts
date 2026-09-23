import { Router } from 'express';
import { and, asc, eq, ilike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { classes, classInvites, enrollments } from '../db/schema/app.js';
import { user } from '../db/schema/auth.js';
import { db } from '../db/index.js';
import { ApiError } from '../lib/api-error.js';
import { requireRole } from '../middleware/auth.js';
import { serializable } from '../services/transaction.js';
import { parseListQuery, pagination } from '../lib/list-query.js';
import { writeAuditEvent } from '../services/audit.js';
import { enroll, hashCode, newInviteCode, unenroll } from '../services/enrollment.js';

const router = Router();
const inviteAttempts = new Map<string, { count: number; reset: number }>();
const enrollmentInput = z.object({ studentId: z.string().min(1).max(200), inviteCode: z.string().min(20).max(200).optional() }).strict();
const inviteInput = z.object({ expiresAt: z.coerce.date().optional(), maxUses: z.coerce.number().int().positive().max(100000).optional() }).strict();
async function manageClass(classId: number, actor: Express.Request['user']) {
  const [row] = await db.select({ teacherId: classes.teacherId }).from(classes).where(eq(classes.id, classId));
  if (!row) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found');
  if (actor!.role !== 'admin' && (actor!.role !== 'teacher' || row.teacherId !== actor!.id)) throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action');
}
function inviteRateLimit(actorId: string) {
  const now = Date.now(), current = inviteAttempts.get(actorId);
  for (const [key, value] of inviteAttempts) if (value.reset < now) inviteAttempts.delete(key);
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
  const list = parseListQuery(req.query, ['name'], 'name'); const page = list.page; const limit = list.pageSize; const search = list.search ?? '';
  const where = search ? and(eq(enrollments.classId, classId), ilike(user.name, `%${search.replace(/[%_]/g, '\\$&')}%`)) : eq(enrollments.classId, classId);
  const [count, rows] = await Promise.all([db.select({ count: sql<number>`count(*)` }).from(enrollments).innerJoin(user, eq(user.id, enrollments.studentId)).where(where), db.select({ studentId: user.id, name: user.name, status: enrollments.status, enrolledAt: enrollments.enrolledAt }).from(enrollments).innerJoin(user, eq(user.id, enrollments.studentId)).where(where).orderBy(asc(user.name), asc(user.id)).limit(limit).offset((page - 1) * limit)]);
  res.json({ data: rows, pagination: { page, limit, total: Number(count[0]?.count ?? 0), totalPages: Math.ceil(Number(count[0]?.count ?? 0) / limit) } });
});

router.post('/classes/:id/invites', async (req, res) => {
  const classId = z.coerce.number().int().positive().parse(req.params.id); await manageClass(classId, req.user); const input = inviteInput.parse(req.body); if (input.expiresAt && input.expiresAt <= new Date()) throw new ApiError(400, 'INVITE_EXPIRY_INVALID', 'Invite expiry must be in the future');
  const code = newInviteCode(); const [invite] = await db.insert(classInvites).values({ classId, codeHash: hashCode(code), expiresAt: input.expiresAt, maxUses: input.maxUses, createdBy: req.user!.id }).returning({ id: classInvites.id, expiresAt: classInvites.expiresAt, maxUses: classInvites.maxUses });
  res.status(201).json({ data: { ...invite, code } });
});
router.get('/classes/:id/invites', async (req, res) => {
  const classId = z.coerce.number().int().positive().parse(req.params.id); await manageClass(classId, req.user);
  const q = parseListQuery(req.query, ['createdAt']);
  const where = eq(classInvites.classId, classId);
  const [count, data] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(classInvites).where(where),
    db.select({ id: classInvites.id, expiresAt: classInvites.expiresAt, revokedAt: classInvites.revokedAt, maxUses: classInvites.maxUses, usedCount: classInvites.usedCount, createdAt: classInvites.createdAt }).from(classInvites).where(where).orderBy(asc(classInvites.createdAt), asc(classInvites.id)).limit(q.pageSize).offset(q.offset),
  ]);
  res.json({ data, pagination: pagination(Number(count[0]?.count ?? 0), q) });
});
for (const action of ['revoke', 'rotate'] as const) router.post(`/classes/:id/invites/:inviteId/${action}`, async (req, res) => {
  const classId = z.coerce.number().int().positive().parse(req.params.id);
  const inviteId = z.uuid().parse(req.params.inviteId);
  await manageClass(classId, req.user);
  const result = await serializable(async tx => {
    const [current] = await tx.select().from(classInvites).where(and(eq(classInvites.id, inviteId), eq(classInvites.classId, classId))).for('update');
    if (!current) throw new ApiError(404, 'INVITE_INVALID', 'Invite was not found');
    if (action === 'rotate' && current.revokedAt) throw new ApiError(409, 'INVITE_INVALID', 'Invite is already revoked');
    await tx.update(classInvites).set({ revokedAt: current.revokedAt ?? new Date() }).where(eq(classInvites.id, inviteId));
    let data: object = { revoked: true };
    if (action === 'rotate') {
      if (current.expiresAt && current.expiresAt <= new Date()) throw new ApiError(409, 'INVITE_EXPIRED', 'Invite has expired');
      const remaining = current.maxUses === null ? null : current.maxUses - current.usedCount;
      if (remaining !== null && remaining <= 0) throw new ApiError(409, 'INVITE_EXHAUSTED', 'No remaining uses');
      const code = newInviteCode();
      const [created] = await tx.insert(classInvites).values({ classId, codeHash: hashCode(code), createdBy: req.user!.id, expiresAt: current.expiresAt, maxUses: remaining }).returning({ id: classInvites.id, expiresAt: classInvites.expiresAt, maxUses: classInvites.maxUses });
      data = { ...created, code };
    }
    await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'class_invite', entityId: inviteId, action: `invite.${action}`, requestId: req.requestId, metadata: { classId } });
    return data;
  });
  res.status(action === 'rotate' ? 201 : 200).json({ data: result });
});
router.post('/enrollments/join', requireRole('student'), async (req, res) => {
  const { code } = z.object({ code: z.string().trim().min(20).max(200) }).strict().parse(req.body);
  inviteRateLimit(req.user!.id);
  const [invite] = await db.select({ classId: classInvites.classId }).from(classInvites).where(eq(classInvites.codeHash, hashCode(code)));
  if (!invite) throw new ApiError(409, 'INVITE_INVALID', 'Invite code is invalid');
  const result = await enroll({ classId: invite.classId, studentId: req.user!.id, actorId: req.user!.id, source: 'invite', inviteCode: code, requestId: req.requestId });
  res.status(201).json({ data: { ...result, classId: invite.classId } });
});
export default router;
