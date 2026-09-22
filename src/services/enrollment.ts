import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { ApiError } from '../lib/api-error.js';
import { writeAuditEvent } from './audit.js';
import { serializable } from './transaction.js';

type Source = 'admin' | 'student' | 'invite' | 'future';
type EnrollInput = { classId: number; studentId: string; actorId: string; source: Source; inviteCode?: string; requestId: string };
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export async function enroll(input: EnrollInput) {
  return serializable(async tx => {
    const classRows = await tx.execute(sql`SELECT c.id, c.capacity, c.lifecycle_status, c.archived_at, ((now() AT TIME ZONE 'Asia/Bangkok')::date BETWEEN s.registration_starts_on::date AND s.registration_ends_on::date) AS registration_open
      FROM classes c JOIN semesters s ON s.id = c.semester_id WHERE c.id=${input.classId} FOR UPDATE`);
    const classroom = classRows.rows[0] as Record<string, unknown> | undefined;
    if (!classroom) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found');
    if (classroom.lifecycle_status !== 'open' || classroom.archived_at) throw new ApiError(409, 'CLASS_NOT_OPEN', 'Class is not open for enrollment');
    const now = new Date();
    if (!classroom.registration_open) throw new ApiError(409, 'REGISTRATION_CLOSED', 'Registration is outside the allowed period');
    const students = await tx.execute(sql`SELECT id, role, is_active FROM "user" WHERE id=${input.studentId} FOR UPDATE`);
    const student = students.rows[0] as Record<string, unknown> | undefined;
    if (!student || student.role !== 'student') throw new ApiError(400, 'STUDENT_INVALID', 'Student must be an active student');
    if (!student.is_active) throw new ApiError(403, 'ACCOUNT_INACTIVE', 'Account is inactive');
    const existing = await tx.execute(sql`SELECT status FROM enrollments WHERE class_id=${input.classId} AND student_id=${input.studentId} FOR UPDATE`);
    if ((existing.rows[0] as { status?: string } | undefined)?.status === 'active') throw new ApiError(409, 'ALREADY_ENROLLED', 'Student is already enrolled');
    let inviteId: string | undefined;
    if (input.inviteCode) {
      const invites = await tx.execute(sql`SELECT id, expires_at, revoked_at, max_uses, used_count FROM class_invites WHERE code_hash=${hashCode(input.inviteCode)} AND class_id=${input.classId} FOR UPDATE`);
      const invite = invites.rows[0] as Record<string, unknown> | undefined;
      if (!invite || invite.revoked_at) throw new ApiError(409, 'INVITE_INVALID', 'Invite code is invalid');
      if (invite.expires_at && now >= new Date(String(invite.expires_at))) throw new ApiError(409, 'INVITE_EXPIRED', 'Invite code has expired');
      if (invite.max_uses !== null && Number(invite.used_count) >= Number(invite.max_uses)) throw new ApiError(409, 'INVITE_EXHAUSTED', 'Invite code has reached its usage limit');
      inviteId = String(invite.id);
    }
    await tx.execute(sql`SELECT c.id FROM enrollments e JOIN classes c ON c.id=e.class_id WHERE e.student_id=${input.studentId} AND e.status='active' ORDER BY c.id FOR UPDATE`);
    const conflicts = await tx.execute(sql`SELECT 1 FROM enrollments e JOIN classes c ON c.id=e.class_id JOIN class_schedules a ON a.class_id=c.id JOIN class_schedules b ON b.class_id=${input.classId} AND a.day_of_week=b.day_of_week AND a.start_time < b.end_time AND b.start_time < a.end_time WHERE e.student_id=${input.studentId} AND e.status='active' AND c.archived_at IS NULL AND c.lifecycle_status NOT IN ('cancelled','completed') AND EXISTS (SELECT 1 FROM semesters current_sem JOIN semesters target_sem ON target_sem.id=(SELECT semester_id FROM classes WHERE id=${input.classId}) WHERE current_sem.id=c.semester_id AND current_sem.starts_on <= target_sem.ends_on AND target_sem.starts_on <= current_sem.ends_on) LIMIT 1`);
    if (conflicts.rows.length) throw new ApiError(409, 'STUDENT_SCHEDULE_CONFLICT', 'Student has an overlapping class schedule');
    const count = await tx.execute(sql`SELECT count(*)::int AS count FROM enrollments WHERE class_id=${input.classId} AND status='active'`);
    if (Number((count.rows[0] as { count?: number }).count ?? 0) >= Number(classroom.capacity)) throw new ApiError(409, 'CLASS_CAPACITY_FULL', 'Class capacity has been reached');
    const reactivated = existing.rows.length > 0;
    if (reactivated) await tx.execute(sql`UPDATE enrollments SET status='active', enrolled_at=now(), cancelled_at=NULL, time_source='recorded' WHERE class_id=${input.classId} AND student_id=${input.studentId}`);
    else await tx.execute(sql`INSERT INTO enrollments (class_id, student_id, status, enrolled_at, time_source) VALUES (${input.classId}, ${input.studentId}, 'active', now(), 'recorded')`);
    if (inviteId) await tx.execute(sql`UPDATE class_invites SET used_count=used_count+1 WHERE id=${inviteId}`);
    await tx.execute(sql`INSERT INTO enrollment_events (student_id,class_id,type,actor_id,source) VALUES (${input.studentId},${input.classId},${reactivated ? 'reactivated' : 'enrolled'},${input.actorId},${input.source})`);
    await writeAuditEvent(tx, { actorId: input.actorId, entityType: 'enrollment', entityId: `${input.classId}:${input.studentId}`, action: reactivated ? 'enrollment.reactivated' : 'enrollment.enrolled', requestId: input.requestId, metadata: { classId: input.classId, studentId: input.studentId, source: input.source } });
    return { status: reactivated ? 'reactivated' : 'enrolled' };
  });
}

export async function unenroll(input: Omit<EnrollInput, 'source' | 'inviteCode'>) {
  return serializable(async tx => {
    await tx.execute(sql`SELECT id FROM classes WHERE id=${input.classId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM "user" WHERE id=${input.studentId} FOR UPDATE`);
    const result = await tx.execute(sql`UPDATE enrollments SET status='cancelled', cancelled_at=now() WHERE class_id=${input.classId} AND student_id=${input.studentId} AND status='active' RETURNING student_id`);
    if (!result.rows.length) return { status: 'already_cancelled' as const };
    await tx.execute(sql`INSERT INTO enrollment_events (student_id,class_id,type,actor_id,source) VALUES (${input.studentId},${input.classId},'cancelled',${input.actorId},'student')`);
    await writeAuditEvent(tx, { actorId: input.actorId, entityType: 'enrollment', entityId: `${input.classId}:${input.studentId}`, action: 'enrollment.cancelled', requestId: input.requestId, metadata: { classId: input.classId, studentId: input.studentId } });
    return { status: 'cancelled' as const };
  });
}

export function newInviteCode() { return randomBytes(32).toString('base64url'); }
export { hashCode };
