import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { classes, classSchedules, semesters } from '../db/schema/app.js';
import { semesterInput } from '../routes/semesters.js';
import { serializable } from './transaction.js';
import { assertClassSchedule } from './class-schedule.js';
import { writeAuditEvent } from './audit.js';

export const assignmentInput = z.object({ semester: semesterInput, classIds: z.array(z.number().int().positive()).min(1) }).strict();
export type Assignment = z.infer<typeof assignmentInput>;
export async function previewSemesterAssignment(config: Assignment) {
  const classIds = [...new Set(config.classIds)];
  const rows = await db.select({ id: classes.id, name: classes.name, semesterId: classes.semesterId, lifecycleStatus: classes.lifecycleStatus }).from(classes).where(inArray(classes.id, classIds)).orderBy(asc(classes.id));
  if (rows.length !== classIds.length) throw new Error('Some classIds do not exist. Nothing was changed.');
  return { semester: config.semester, classes: rows };
}
export async function assignSemester(config: Assignment) {
  const classIds = [...new Set(config.classIds)];
  return serializable(async tx => {
      let [semester] = await tx.select().from(semesters).where(eq(semesters.code, config.semester.code)).for('update');
      if (semester) {
        for (const key of ['startsOn', 'endsOn', 'registrationStartsOn', 'registrationEndsOn'] as const) {
          if (semester[key].toISOString().slice(0, 10) !== config.semester[key].toISOString().slice(0, 10)) throw new Error('Existing semester dates differ. Use its actual dates or edit it through the application first.');
        }
      } else [semester] = await tx.insert(semesters).values(config.semester).returning();
      if (!semester) throw new Error('Semester creation failed');
      const rows = await tx.select().from(classes).where(inArray(classes.id, classIds)).orderBy(asc(classes.id)).for('update');
      if (rows.length !== classIds.length) throw new Error('Some classIds do not exist. Transaction rolled back.');
      for (const row of rows) if (row.semesterId !== null && row.semesterId !== semester.id) throw new Error(`Class ${row.id} already belongs to another semester. Use the edit form to change it.`);
      const changed = await tx.update(classes).set({ semesterId: semester.id }).where(and(inArray(classes.id, classIds), isNull(classes.semesterId))).returning({ id: classes.id });
      for (const row of rows) {
        const schedules = await tx.select().from(classSchedules).where(eq(classSchedules.classId, row.id));
        // Raw legacy schedules remain intact; incomplete migration needs human review.
        if (!Array.isArray(row.schedules) || row.schedules.length > schedules.length) throw new Error(`Class ${row.id} has unconverted legacy schedules. Review and save its schedule in the class edit form first.`);
        await assertClassSchedule(tx, row.id, row.teacherId, semester.id, schedules, !row.archivedAt && !['cancelled', 'completed'].includes(row.lifecycleStatus));
      }
      for (const row of changed) await writeAuditEvent(tx, { entityType: 'class', entityId: String(row.id), action: 'class.semester_assigned', requestId: randomUUID(), metadata: { semesterId: semester.id, source: 'assign-semester-script' } });
      return { semesterId: semester.id, assignedClassIds: changed.map(row => row.id) };
    });
}
