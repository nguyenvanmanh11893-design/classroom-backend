import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { ApiError } from '../lib/api-error.js';
import { writeAuditEvent } from './audit.js';
import { serializable } from './transaction.js';

type Source = 'admin' | 'student' | 'invite' | 'future';
type EnrollInput = { classId: number; studentId: string; actorId: string; source: Source; inviteCode?: string; registrationPeriodId?: number; requestId: string };
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export async function enroll(input: EnrollInput) {
  return serializable(async tx => {
    const classRows = await tx.execute(sql`SELECT c.id, c.capacity, c.lifecycle_status, c.archived_at, c.schedule_review_required, c.semester_id
      FROM classes c WHERE c.id=${input.classId} FOR UPDATE`);
    const classroom = classRows.rows[0] as Record<string, unknown> | undefined;
    if (!classroom) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found');
    if (classroom.lifecycle_status !== 'open' || classroom.archived_at) throw new ApiError(409, 'CLASS_NOT_OPEN', 'Class is not open for enrollment');
    const now = new Date();
    if (classroom.schedule_review_required) throw new ApiError(409, 'SCHEDULE_REQUIRED', 'Class schedule needs administrator review');
    const ready = await tx.execute(sql`SELECT 1 FROM class_sessions WHERE class_id=${input.classId} AND status='scheduled' LIMIT 1`);
    if (!ready.rows.length) throw new ApiError(409, 'SCHEDULE_REQUIRED', 'Class has no scheduled sessions');
    const periods = await tx.execute(sql`SELECT p.id FROM registration_periods p
      JOIN registration_period_classes pc ON pc.period_id=p.id JOIN semesters s ON s.id=p.semester_id
      WHERE pc.class_id=${input.classId} AND p.semester_id=${Number(classroom.semester_id)} AND s.status='active'
        AND p.status='open' AND now()>=p.opens_at AND now()<p.closes_at
        ${input.registrationPeriodId === undefined ? sql`` : sql`AND p.id=${input.registrationPeriodId}`}
      ORDER BY p.opens_at DESC,p.id DESC LIMIT 1 FOR UPDATE OF p`);
    const periodId = Number(periods.rows[0]?.id);
    if (!periodId) throw new ApiError(409, 'REGISTRATION_CLOSED', 'No open registration period includes this class');
    const students = await tx.execute(sql`SELECT id, role, is_active FROM "user" WHERE id=${input.studentId} FOR UPDATE`);
    const student = students.rows[0] as Record<string, unknown> | undefined;
    if (!student || student.role !== 'student') throw new ApiError(400, 'STUDENT_INVALID', 'Student must be an active student');
    if (!student.is_active) throw new ApiError(403, 'ACCOUNT_INACTIVE', 'Account is inactive');
    const profiles = await tx.execute(sql`SELECT academic_status FROM student_profiles WHERE user_id=${input.studentId}`);
    if (!profiles.rows.length) throw new ApiError(409, 'STUDENT_PROFILE_REQUIRED', 'Student needs an academic profile');
    if (profiles.rows[0]?.academic_status !== 'studying') throw new ApiError(409, 'STUDENT_NOT_ELIGIBLE', 'Student academic status does not allow registration');
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
    const unreviewed = await tx.execute(sql`SELECT 1 FROM enrollments e JOIN classes c ON c.id=e.class_id
      WHERE e.student_id=${input.studentId} AND e.status='active' AND c.schedule_review_required
        AND c.archived_at IS NULL AND c.lifecycle_status NOT IN ('cancelled','completed') LIMIT 1`);
    if (unreviewed.rows.length) throw new ApiError(409, 'SCHEDULE_REVIEW_REQUIRED', 'An existing enrollment needs dated schedule review before checking conflicts');
    const sameSubject = await tx.execute(sql`SELECT 1 FROM enrollments e
      JOIN classes enrolled ON enrolled.id=e.class_id
      JOIN classes target ON target.id=${input.classId}
      WHERE e.student_id=${input.studentId} AND e.status='active' AND e.class_id<>${input.classId}
        AND enrolled.subject_id=target.subject_id AND enrolled.semester_id=target.semester_id
      LIMIT 1`);
    if (sameSubject.rows.length) throw new ApiError(409, 'SUBJECT_ALREADY_ENROLLED', 'Student is already enrolled in this subject for the semester');
    const conflicts = await tx.execute(sql`SELECT 1 FROM enrollments e JOIN classes c ON c.id=e.class_id
      JOIN class_sessions a ON a.class_id=c.id AND a.status='scheduled'
      JOIN class_sessions b ON b.class_id=${input.classId} AND b.status='scheduled' AND a.session_date=b.session_date
        AND a.start_time<b.end_time AND b.start_time<a.end_time
      WHERE e.student_id=${input.studentId} AND e.status='active' AND c.archived_at IS NULL AND c.lifecycle_status NOT IN ('cancelled','completed') LIMIT 1`);
    if (conflicts.rows.length) throw new ApiError(409, 'STUDENT_SCHEDULE_CONFLICT', 'Student has an overlapping class schedule');
    const count = await tx.execute(sql`SELECT count(*)::int AS count FROM enrollments WHERE class_id=${input.classId} AND status='active'`);
    if (Number((count.rows[0] as { count?: number }).count ?? 0) >= Number(classroom.capacity)) throw new ApiError(409, 'CLASS_CAPACITY_FULL', 'Class capacity has been reached');
    const reactivated = existing.rows.length > 0;
    if (reactivated) await tx.execute(sql`UPDATE enrollments SET status='active', enrolled_at=now(), cancelled_at=NULL, time_source='recorded', registration_period_id=${periodId} WHERE class_id=${input.classId} AND student_id=${input.studentId}`);
    else await tx.execute(sql`INSERT INTO enrollments (class_id, student_id, status, enrolled_at, time_source, registration_period_id) VALUES (${input.classId}, ${input.studentId}, 'active', now(), 'recorded', ${periodId})`);
    if (inviteId) await tx.execute(sql`UPDATE class_invites SET used_count=used_count+1 WHERE id=${inviteId}`);
    await tx.execute(sql`INSERT INTO enrollment_events (student_id,class_id,type,actor_id,source,registration_period_id) VALUES (${input.studentId},${input.classId},${reactivated ? 'reactivated' : 'enrolled'},${input.actorId},${input.source},${periodId})`);
    await writeAuditEvent(tx, { actorId: input.actorId, entityType: 'enrollment', entityId: `${input.classId}:${input.studentId}`, action: reactivated ? 'enrollment.reactivated' : 'enrollment.enrolled', requestId: input.requestId, metadata: { classId: input.classId, studentId: input.studentId, source: input.source } });
    return { status: reactivated ? 'reactivated' : 'enrolled', registrationPeriodId: periodId };
  });
}

export async function unenroll(input: Omit<EnrollInput, 'source' | 'inviteCode'>) {
  return serializable(async tx => {
    await tx.execute(sql`SELECT id FROM classes WHERE id=${input.classId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM "user" WHERE id=${input.studentId} FOR UPDATE`);
    const current = await tx.execute(sql`SELECT e.registration_period_id, p.cancellation_deadline
      FROM enrollments e LEFT JOIN registration_periods p ON p.id=e.registration_period_id
      WHERE e.class_id=${input.classId} AND e.student_id=${input.studentId} AND e.status='active'`);
    if (!current.rows.length) return { status: 'already_cancelled' as const };
    const periodId = current.rows[0]?.registration_period_id;
    if (!periodId) {
      const actor = await tx.execute(sql`SELECT 1 FROM "user" WHERE id=${input.actorId} AND role='admin' AND is_active`);
      if (!actor.rows.length) throw new ApiError(409, 'LEGACY_ENROLLMENT_REVIEW_REQUIRED', 'An administrator must handle this legacy enrollment');
    } else if (new Date(String(current.rows[0]?.cancellation_deadline)) <= new Date()) throw new ApiError(409, 'CANCELLATION_CLOSED', 'Cancellation deadline has passed');
    const result = await tx.execute(sql`UPDATE enrollments SET status='cancelled', cancelled_at=now() WHERE class_id=${input.classId} AND student_id=${input.studentId} AND status='active' RETURNING student_id`);
    if (!result.rows.length) return { status: 'already_cancelled' as const };
    await tx.execute(sql`INSERT INTO enrollment_events (student_id,class_id,type,actor_id,source,registration_period_id) VALUES (${input.studentId},${input.classId},'cancelled',${input.actorId},${input.actorId === input.studentId ? 'student' : 'admin'},${periodId ?? null})`);
    await writeAuditEvent(tx, { actorId: input.actorId, entityType: 'enrollment', entityId: `${input.classId}:${input.studentId}`, action: 'enrollment.cancelled', requestId: input.requestId, metadata: { classId: input.classId, studentId: input.studentId } });
    return { status: 'cancelled' as const };
  });
}

export function newInviteCode() { return randomBytes(32).toString('base64url'); }
export { hashCode };
