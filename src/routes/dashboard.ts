import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { ApiError } from '../lib/api-error.js';

const router = Router();
const querySchema = z.object({ semesterId: z.coerce.number().int().positive().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).strict();
const scope = (actor: Express.Request['user']) => actor!.role === 'admin'
  ? sql`TRUE`
  : actor!.role === 'teacher' ? sql`c.teacher_id = ${actor!.id}` : sql`EXISTS (SELECT 1 FROM enrollments own WHERE own.class_id=c.id AND own.student_id=${actor!.id} AND own.status='active')`;
function period(input: z.infer<typeof querySchema>) {
  const to = input.to ?? new Date(); const from = input.from ?? new Date(to.getTime() - 29 * 86_400_000);
  if (from > to || to.getTime() - from.getTime() > 366 * 86_400_000) throw new ApiError(400, 'DATE_RANGE_INVALID', 'Date range is invalid');
  return { from, to: new Date(to.getTime() + 86_400_000) };
}

router.get('/dashboard', async (req, res) => {
  const input = querySchema.parse(req.query); const range = period(input); const classScope = scope(req.user); const semester = input.semesterId ? sql`AND c.semester_id=${input.semesterId}` : sql``;
  const [cards, active] = await Promise.all([db.execute(sql`SELECT
    count(*) FILTER (WHERE c.lifecycle_status='open' AND c.archived_at IS NULL)::int AS open_classes,
    coalesce(sum(c.capacity),0)::int AS capacity FROM classes c WHERE ${classScope} ${semester}`),
    db.execute(sql`SELECT count(*)::int AS active_enrollments FROM enrollments e JOIN classes c ON c.id=e.class_id WHERE e.status='active' AND ${classScope} ${semester}`)]);
  const classesByDepartment = await db.execute(sql`SELECT d.id, d.name, count(c.id)::int AS value FROM classes c JOIN subjects s ON s.id=c.subject_id JOIN departments d ON d.id=s.department_id WHERE ${classScope} ${semester} GROUP BY d.id,d.name ORDER BY value DESC,d.id ASC LIMIT 20`);
  const capacityStatus = await db.execute(sql`WITH per_class AS (
    SELECT c.id, c.capacity, count(e.student_id)::int AS enrolled
    FROM classes c LEFT JOIN enrollments e ON e.class_id=c.id AND e.status='active'
    WHERE ${classScope} ${semester} GROUP BY c.id, c.capacity
  ), classified AS (
    SELECT CASE WHEN enrolled >= capacity THEN 'full'
      WHEN enrolled::numeric / NULLIF(capacity,0) >= .8 THEN 'near' ELSE 'available' END AS key FROM per_class
  ) SELECT key, count(*)::int AS value FROM classified GROUP BY key ORDER BY key`);
  const trend = await db.execute(sql`SELECT (ee.occurred_at AT TIME ZONE 'Asia/Bangkok')::date::text AS date, count(*) FILTER (WHERE ee.type IN ('enrolled','reactivated'))::int AS enrolled, count(*) FILTER (WHERE ee.type='cancelled')::int AS cancelled FROM enrollment_events ee JOIN classes c ON c.id=ee.class_id WHERE ${classScope} ${semester} AND ee.occurred_at >= ${range.from} AND ee.occurred_at < ${range.to} GROUP BY 1 ORDER BY 1`);
  const userDistribution = req.user!.role === 'admin' ? await db.execute(sql`SELECT role::text AS key, count(*) FILTER (WHERE is_active)::int AS value FROM "user" GROUP BY role ORDER BY role`) : { rows: [] };
  const activities = await db.execute(sql`SELECT ee.id, ee.type::text AS type, ee.class_id AS "classId", c.name AS "className", ee.occurred_at AS "occurredAt" FROM enrollment_events ee JOIN classes c ON c.id=ee.class_id WHERE ${classScope} ${semester} ORDER BY ee.occurred_at DESC LIMIT 20`);
  const unknownLegacy = await db.execute(sql`SELECT count(*)::int AS count FROM enrollments e JOIN classes c ON c.id=e.class_id WHERE ${classScope} ${semester} AND e.time_source='legacy_unknown'`);
  const row = cards.rows[0] as { open_classes?: number; capacity?: number } | undefined;
  const activeEnrollments = Number((active.rows[0] as { active_enrollments?: number } | undefined)?.active_enrollments ?? 0), capacity = Number(row?.capacity ?? 0);
  res.json({ data: { timezone: 'Asia/Bangkok', dateRange: { from: range.from.toISOString(), toExclusive: range.to.toISOString() }, summary: { openClasses: Number(row?.open_classes ?? 0), activeEnrollments, capacity, utilization: capacity ? activeEnrollments / capacity : null }, charts: { enrollmentTrend: trend.rows, classesByDepartment: classesByDepartment.rows, capacityStatus: capacityStatus.rows, userDistribution: userDistribution.rows }, activity: activities.rows, legacyUnknownEnrollmentCount: Number((unknownLegacy.rows[0] as { count?: number } | undefined)?.count ?? 0) } });
});

router.get('/search', async (req, res) => {
  const q = z.string().trim().min(2).max(100).parse(req.query.q); const actor = req.user!; const classScope = scope(actor); const term = `%${q.replace(/[%_]/g, '\\$&')}%`;
  const [classRows, subjectRows, departmentRows, userRows] = await Promise.all([
    db.execute(sql`SELECT c.id, c.name, 'class' AS type FROM classes c WHERE ${classScope} AND c.name ILIKE ${term} ORDER BY c.name,c.id LIMIT 8`),
    db.execute(sql`SELECT s.id, s.name, 'subject' AS type FROM subjects s JOIN classes c ON c.subject_id=s.id WHERE ${classScope} AND (s.name ILIKE ${term} OR s.code ILIKE ${term}) GROUP BY s.id,s.name ORDER BY s.name,s.id LIMIT 8`),
    db.execute(sql`SELECT d.id, d.name, 'department' AS type FROM departments d JOIN subjects s ON s.department_id=d.id JOIN classes c ON c.subject_id=s.id WHERE ${classScope} AND d.name ILIKE ${term} GROUP BY d.id,d.name ORDER BY d.name,d.id LIMIT 8`),
    actor.role === 'admin' ? db.execute(sql`SELECT id, name, 'user' AS type FROM "user" WHERE is_active AND name ILIKE ${term} ORDER BY name,id LIMIT 8`) : Promise.resolve({ rows: [] }),
  ]);
  res.json({ data: [...classRows.rows, ...subjectRows.rows, ...departmentRows.rows, ...userRows.rows] });
});
export default router;
