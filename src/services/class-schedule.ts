import { sql } from 'drizzle-orm';
import { ApiError } from '../lib/api-error.js';
import type { Tx } from './transaction.js';

export type ScheduleInput = { dayOfWeek: number; startTime: string; endTime: string };

export async function assertClassSchedule(tx: Tx, classId: number | undefined, teacherId: string, semesterId: number, schedules: ScheduleInput[], enabled = true) {
  const semester = await tx.execute(sql`SELECT id FROM semesters WHERE id=${semesterId}`);
  if (!semester.rows.length) throw new ApiError(400, 'SEMESTER_NOT_FOUND', 'Semester was not found');
  for (let i = 0; i < schedules.length; i++) {
    const a = schedules[i]!;
    if (schedules.slice(i + 1).some(b => a.dayOfWeek === b.dayOfWeek && a.startTime < b.endTime && b.startTime < a.endTime)) {
      throw new ApiError(409, 'CLASS_SCHEDULE_CONFLICT', 'Sessions in this class overlap');
    }
  }
  if (!enabled || !schedules.length) return;
  const proposed = sql.join(schedules.map(s => sql`(${s.dayOfWeek}::integer, ${s.startTime}::text, ${s.endTime}::text)`), sql`, `);
  // Compare date ranges, including two different semesters whose dates overlap.
  const common = sql`FROM classes c
    JOIN semesters existing ON existing.id=c.semester_id
    JOIN semesters target ON target.id=${semesterId}
    JOIN class_schedules s ON s.class_id=c.id
    JOIN (VALUES ${proposed}) proposed(day_of_week,start_time,end_time)
      ON proposed.day_of_week=s.day_of_week AND proposed.start_time < s.end_time AND s.start_time < proposed.end_time
    WHERE c.archived_at IS NULL AND c.lifecycle_status NOT IN ('cancelled','completed')
      AND existing.starts_on <= target.ends_on AND target.starts_on <= existing.ends_on
      ${classId === undefined ? sql`` : sql`AND c.id <> ${classId}`}`;
  const teacher = await tx.execute(sql`SELECT c.id ${common} AND c.teacher_id=${teacherId} LIMIT 1`);
  if (teacher.rows.length) throw new ApiError(409, 'TEACHER_SCHEDULE_CONFLICT', 'Teacher has an overlapping class schedule');
  if (classId !== undefined) {
    const students = await tx.execute(sql`SELECT c.id ${common} AND EXISTS (
      SELECT 1 FROM enrollments other JOIN enrollments own ON own.student_id=other.student_id
      WHERE other.class_id=c.id AND other.status='active' AND own.class_id=${classId} AND own.status='active'
    ) LIMIT 1`);
    if (students.rows.length) throw new ApiError(409, 'STUDENT_SCHEDULE_CONFLICT', 'An enrolled student has an overlapping class schedule');
  }
}
