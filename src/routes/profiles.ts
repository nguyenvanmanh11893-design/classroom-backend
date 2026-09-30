import { Router } from 'express';
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { studentProfiles, teacherProfiles } from '../db/schema/app.js';
import { user } from '../db/schema/auth.js';
import { requireRole } from '../middleware/auth.js';
import { ApiError } from '../lib/api-error.js';
import { calendarDate } from '../lib/calendar.js';
import { pagination, parseListQuery } from '../lib/list-query.js';
import { serializable } from '../services/transaction.js';
import { writeAuditEvent } from '../services/audit.js';

const router = Router();
const phone = z.string().trim().max(30).nullable();
const common = { departmentId: z.number().int().positive(), phone: phone.optional() };
const studentInput = z.object({ ...common, studentCode: z.string().trim().min(1).max(50), major: z.string().trim().max(200).nullable().optional(), admissionYear: z.number().int().min(1900).max(2200), dateOfBirth: calendarDate.refine(v => v <= new Date().toISOString().slice(0, 10)).nullable().optional(), academicStatus: z.enum(['studying', 'suspended', 'graduated', 'withdrawn']).default('studying') }).strict();
const teacherInput = z.object({ ...common, teacherCode: z.string().trim().min(1).max(50), academicDegree: z.string().trim().max(100).nullable().optional(), specialization: z.string().trim().max(200).nullable().optional(), employmentStatus: z.enum(['active', 'on_leave', 'inactive']).default('active') }).strict();

async function readProfile(id: string) {
  const [account] = await db.select({ id: user.id, name: user.name, email: user.email, role: user.role, image: user.image }).from(user).where(eq(user.id, id));
  if (!account) throw new ApiError(404, 'USER_NOT_FOUND', 'User was not found');
  const [profile] = account.role === 'student'
    ? await db.select().from(studentProfiles).where(eq(studentProfiles.userId, id))
    : account.role === 'teacher' ? await db.select().from(teacherProfiles).where(eq(teacherProfiles.userId, id)) : [];
  return { ...account, profile: profile ?? null };
}
router.get('/me', async (req, res) => res.json({ data: await readProfile(req.user!.id) }));
router.patch('/me', async (req, res) => {
  const input = z.object({ phone }).strict().parse(req.body);
  const result = await serializable(async tx => {
    const table = req.user!.role === 'student' ? studentProfiles : req.user!.role === 'teacher' ? teacherProfiles : null;
    if (!table) throw new ApiError(403, 'PROFILE_ROLE_INVALID', 'This role has no academic profile');
    const [row] = await tx.update(table).set(input).where(eq(table.userId, req.user!.id)).returning();
    if (!row) throw new ApiError(404, 'PROFILE_REQUIRED', 'Ask an administrator to create your academic profile');
    await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'profile', entityId: req.user!.id, action: 'profile.contact.updated', requestId: req.requestId });
    return row;
  });
  res.json({ data: result });
});
router.use(requireRole('admin'));
router.get('/', async (req, res) => {
  const role = z.enum(['student', 'teacher']).parse(req.query.role);
  const q = parseListQuery(req.query, ['name'], 'name');
  const table = role === 'student' ? studentProfiles : teacherProfiles;
  const code = role === 'student' ? studentProfiles.studentCode : teacherProfiles.teacherCode;
  const where = and(eq(user.role, role), q.search ? or(ilike(user.name, `%${q.search}%`), ilike(code, `%${q.search}%`)) : undefined);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(user).leftJoin(table, eq(table.userId, user.id)).where(where);
  const rows = await db.select({ account: { id: user.id, name: user.name, email: user.email, role: user.role, isActive: user.isActive }, profile: table }).from(user).leftJoin(table, eq(table.userId, user.id)).where(where).orderBy(asc(user.name), asc(user.id)).limit(q.pageSize).offset(q.offset);
  res.json({ data: rows, pagination: pagination(count?.n ?? 0, q) });
});
router.get('/:userId', async (req, res) => res.json({ data: await readProfile(String(req.params.userId)) }));
router.put('/:userId', async (req, res) => {
  const id = z.string().min(1).max(200).parse(req.params.userId);
  const data = await serializable(async tx => {
    const [account] = await tx.select().from(user).where(eq(user.id, id)).for('update');
    if (!account) throw new ApiError(404, 'USER_NOT_FOUND', 'User was not found');
    let row;
    if (account.role === 'student') {
      const value = studentInput.parse(req.body);
      [row] = await tx.insert(studentProfiles).values({ userId: id, ...value }).onConflictDoUpdate({ target: studentProfiles.userId, set: value }).returning();
    } else if (account.role === 'teacher') {
      const value = teacherInput.parse(req.body);
      [row] = await tx.insert(teacherProfiles).values({ userId: id, ...value }).onConflictDoUpdate({ target: teacherProfiles.userId, set: value }).returning();
    } else throw new ApiError(400, 'PROFILE_ROLE_INVALID', 'Only teachers and students have academic profiles');
    await writeAuditEvent(tx, { actorId: req.user!.id, entityType: 'profile', entityId: id, action: 'profile.saved', requestId: req.requestId });
    return row;
  });
  res.json({ data });
});
export default router;
