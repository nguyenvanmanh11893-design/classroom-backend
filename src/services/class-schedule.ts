import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { classSessions, classes, semesters, timeSlots } from '../db/schema/app.js';
import { ApiError } from '../lib/api-error.js';
import { calendarDate } from '../lib/calendar.js';
import type { Tx } from './transaction.js';

export const ruleInput = z.object({ dayOfWeek: z.number().int().min(1).max(7), timeSlotId: z.number().int().positive() }).strict();
export const schedulePlanInput = z.object({ startsOn: calendarDate, endsOn: calendarDate, schedules: z.array(ruleInput).min(1).max(28) }).strict();
export type ScheduleInput = { dayOfWeek: number; timeSlotId: number; startTime: string; endTime: string };
export type SessionInput = { sessionDate: string; timeSlotId: number; startTime: string; endTime: string; status: string };
export type ScheduleContext = { id?: number; teacherId: string; subjectId: number; semesterId: number; startsOn: string; endsOn: string; lifecycleStatus: string; archivedAt?: Date | null };

export async function resolveRules(tx: Tx, rules: z.infer<typeof ruleInput>[]) {
  if (!rules.length) return [];
  const slots = await tx.select().from(timeSlots).where(inArray(timeSlots.id, rules.map(r => r.timeSlotId)));
  return rules.map(rule => {
    const slot = slots.find(s => s.id === rule.timeSlotId);
    if (!slot?.isActive) throw new ApiError(400, 'TIME_SLOT_INVALID', 'Choose an active time slot');
    return { ...rule, startTime: slot.startTime, endTime: slot.endTime };
  });
}
export function generateSessions(startsOn: string, endsOn: string, rules: ScheduleInput[]): SessionInput[] {
  calendarDate.parse(startsOn); calendarDate.parse(endsOn);
  const start = Date.parse(`${startsOn}T00:00:00Z`), end = Date.parse(`${endsOn}T00:00:00Z`);
  if (end < start || end - start > 731 * 86400000) throw new ApiError(400, 'CLASS_DATE_RANGE_INVALID', 'Class date range must be ordered and at most two years');
  const sessions: SessionInput[] = [];
  for (let day = start; day <= end; day += 86400000) {
    const date = new Date(day), weekday = date.getUTCDay() || 7;
    for (const rule of rules) if (rule.dayOfWeek === weekday) sessions.push({ sessionDate: date.toISOString().slice(0, 10), timeSlotId: rule.timeSlotId, startTime: rule.startTime, endTime: rule.endTime, status: 'scheduled' });
  }
  if (!sessions.length || sessions.length > 2000) throw new ApiError(400, 'SESSION_COUNT_INVALID', 'A class must have between 1 and 2000 sessions');
  return sessions.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.startTime.localeCompare(b.startTime));
}
export function sessionStarted(session: Pick<SessionInput, 'sessionDate' | 'startTime'>) {
  return new Date(`${session.sessionDate}T${session.startTime}:00+07:00`).getTime() <= Date.now();
}
export async function assertClassSessions(tx: Tx, context: ScheduleContext, sessions: SessionInput[]) {
  const [semester] = await tx.select().from(semesters).where(eq(semesters.id, context.semesterId));
  if (!semester) throw new ApiError(400, 'SEMESTER_NOT_FOUND', 'Semester was not found');
  if (context.startsOn > context.endsOn || context.startsOn < semester.startsOn.toISOString().slice(0, 10) || context.endsOn > semester.endsOn.toISOString().slice(0, 10)) throw new ApiError(400, 'CLASS_OUTSIDE_SEMESTER', 'Class dates must be within the semester');
  const active = sessions.filter(s => s.status !== 'cancelled').sort((a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.startTime.localeCompare(b.startTime));
  if (!active.length && context.lifecycleStatus === 'open' && !context.archivedAt) throw new ApiError(409, 'SCHEDULE_REQUIRED', 'Publish at least one session before opening registration');
  for (let i = 0; i < active.length; i++) {
    const a = active[i]!, b = active[i + 1];
    if (a.sessionDate < context.startsOn || a.sessionDate > context.endsOn) throw new ApiError(400, 'SESSION_OUTSIDE_CLASS', 'Session date must be within the class date range');
    if (a.startTime >= a.endTime || (b && a.sessionDate === b.sessionDate && a.endTime > b.startTime)) throw new ApiError(409, 'CLASS_SCHEDULE_CONFLICT', 'Sessions in this class overlap');
  }
  if (!active.length || context.archivedAt || ['cancelled', 'completed'].includes(context.lifecycleStatus)) return;
  if (context.id !== undefined) {
    const first = active[0]!;
    const late = await tx.execute(sql`SELECT 1 FROM registration_periods p JOIN registration_period_classes pc ON pc.period_id=p.id
      WHERE pc.class_id=${context.id} AND p.status='open'
        AND p.closes_at>(${first.sessionDate}::date + ${first.startTime}::time) AT TIME ZONE 'Asia/Bangkok' LIMIT 1`);
    if (late.rows.length) throw new ApiError(409, 'REGISTRATION_AFTER_CLASS_START', 'Close registration before the first session');
  }
  const proposed = sql.join(active.map(s => sql`(${s.sessionDate}::date,${s.startTime}::text,${s.endTime}::text)`), sql`, `);
  const common = sql`FROM classes c JOIN class_sessions s ON s.class_id=c.id
    JOIN (VALUES ${proposed}) p(day,start_time,end_time) ON p.day=s.session_date AND p.start_time<s.end_time AND s.start_time<p.end_time
    WHERE c.archived_at IS NULL AND c.lifecycle_status NOT IN ('cancelled','completed') AND s.status='scheduled'
    ${context.id === undefined ? sql`` : sql`AND c.id<>${context.id}`}`;
  const teacher = await tx.execute(sql`SELECT c.id ${common} AND c.teacher_id=${context.teacherId} LIMIT 1`);
  if (teacher.rows.length) throw new ApiError(409, 'TEACHER_SCHEDULE_CONFLICT', 'Teacher has an overlapping session');
  const subject = await tx.execute(sql`SELECT c.id ${common} AND c.subject_id=${context.subjectId} AND c.semester_id=${context.semesterId} LIMIT 1`);
  if (subject.rows.length) throw new ApiError(409, 'SUBJECT_SCHEDULE_CONFLICT', 'Sections of the same subject in this semester cannot overlap');
  if (context.id !== undefined) {
    const students = await tx.execute(sql`SELECT c.id ${common} AND EXISTS (
      SELECT 1 FROM enrollments other JOIN enrollments own ON own.student_id=other.student_id
      WHERE other.class_id=c.id AND other.status='active' AND own.class_id=${context.id} AND own.status='active') LIMIT 1`);
    if (students.rows.length) throw new ApiError(409, 'STUDENT_SCHEDULE_CONFLICT', 'An enrolled student has an overlapping session');
  }
}
export async function assertStoredClassSchedule(tx: Tx, classId: number, semesterId?: number) {
  const [row] = await tx.select().from(classes).where(eq(classes.id, classId));
  if (!row) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found');
  if (!row.startsOn || !row.endsOn || !(semesterId ?? row.semesterId)) return;
  await assertClassSessions(tx, { ...row, startsOn: row.startsOn, endsOn: row.endsOn, semesterId: semesterId ?? row.semesterId! }, await tx.select().from(classSessions).where(eq(classSessions.classId, classId)));
}
