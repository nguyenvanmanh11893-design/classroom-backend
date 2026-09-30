import { and, eq, exists, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { classes, enrollments } from '../db/schema/app.js';
import { ApiError } from '../lib/api-error.js';

export function catalogCondition() {
  return sql`${classes.lifecycleStatus}='open' AND ${classes.archivedAt} IS NULL AND ${classes.scheduleReviewRequired}=false
    AND EXISTS (SELECT 1 FROM class_sessions cs WHERE cs.class_id=${classes.id} AND cs.status='scheduled')
    AND EXISTS (SELECT 1 FROM registration_periods rp JOIN registration_period_classes rpc ON rpc.period_id=rp.id
      JOIN semesters sem ON sem.id=rp.semester_id
      WHERE rpc.class_id=${classes.id} AND rp.semester_id=${classes.semesterId} AND sem.status='active'
        AND rp.status='open' AND now()>=rp.opens_at AND now()<rp.closes_at)`;
}
export function classVisibility(actor: NonNullable<Express.Request['user']>, scope: 'all' | 'mine' | 'catalog' = 'all') {
  if (actor.role === 'admin') return undefined;
  if (actor.role === 'teacher') return eq(classes.teacherId, actor.id);
  const mine = exists(db.select({ value: sql`1` }).from(enrollments).where(and(eq(enrollments.classId, classes.id), eq(enrollments.studentId, actor.id), ...(scope === 'mine' ? [eq(enrollments.status, 'active')] : []))));
  return scope === 'mine' ? mine : scope === 'catalog' ? catalogCondition() : or(mine, catalogCondition());
}
export async function visibleClass(id: number, actor: NonNullable<Express.Request['user']>) {
  const [row] = await db.select().from(classes).where(and(eq(classes.id, id), classVisibility(actor)));
  if (!row) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Class was not found');
  return row;
}
