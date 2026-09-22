import express from 'express';
import { and, asc, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import { z } from 'zod'; import { db } from '../db/index.js'; import { semesters } from '../db/schema/app.js'; import { ApiError } from '../lib/api-error.js'; import { pagination, parseListQuery } from '../lib/list-query.js'; import { requireRole } from '../middleware/auth.js';
import { serializable } from '../services/transaction.js';
import { assertClassSchedule } from '../services/class-schedule.js';
import { classes, classSchedules } from '../db/schema/app.js';
const router=express.Router(); router.use(requireRole('admin'));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((value, ctx) => {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
    ctx.addIssue({ code: 'custom', message: 'Invalid calendar date' });
    return z.NEVER;
  }
  return parsed;
});
const semesterFields=z.object({code:z.string().trim().min(1).max(50),name:z.string().trim().min(1).max(255),startsOn:date,endsOn:date,registrationStartsOn:date,registrationEndsOn:date,status:z.enum(['draft','active','archived']).optional()}).strict();
export const semesterInput=semesterFields.superRefine((v,c)=>{if(v.startsOn>v.endsOn)c.addIssue({code:'custom',path:['endsOn'],message:'End must follow start'});if(v.registrationStartsOn>v.registrationEndsOn)c.addIssue({code:'custom',path:['registrationEndsOn'],message:'Registration end must follow start'});if(v.registrationStartsOn<v.startsOn||v.registrationEndsOn>v.endsOn)c.addIssue({code:'custom',path:['registrationStartsOn'],message:'Registration must be within semester'});}); export const semesterPatchInput=semesterFields.partial(); const id=(v:unknown)=>z.coerce.number().int().positive().parse(v);
router.get('/',async(req,res)=>{const q=parseListQuery(req.query,['id','code','name','startsOn','endsOn','createdAt']);const from=req.query.from?date.parse(req.query.from):undefined,to=req.query.to?date.parse(req.query.to):undefined;const f=[];if(q.search)f.push(ilike(semesters.name,`%${q.search}%`));if(from)f.push(gte(semesters.endsOn,from));if(to)f.push(lte(semesters.startsOn,to));const where=f.length?and(...f):undefined;const cols={id:semesters.id,code:semesters.code,name:semesters.name,startsOn:semesters.startsOn,endsOn:semesters.endsOn,createdAt:semesters.createdAt}as const,o=q.order==='asc'?asc:desc;const [c,data]=await Promise.all([db.select({count:sql<number>`count(*)`}).from(semesters).where(where),db.select().from(semesters).where(where).orderBy(o(cols[q.sort as keyof typeof cols]),asc(semesters.id)).limit(q.pageSize).offset(q.offset)]);res.json({data,pagination:pagination(Number(c[0]?.count??0),q)});});
router.get('/:id',async(req,res)=>{const [r]=await db.select().from(semesters).where(eq(semesters.id,id(req.params.id)));if(!r)throw new ApiError(404,'SEMESTER_NOT_FOUND','Semester was not found');res.json({data:r});});router.post('/',async(req,res)=>{const data=semesterInput.parse(req.body);const [existing]=await db.select({id:semesters.id}).from(semesters).where(eq(semesters.code,data.code));if(existing)throw new ApiError(409,'SEMESTER_CODE_IN_USE','Semester code is already in use');const [r]=await db.insert(semesters).values(data).returning();res.status(201).json({data:r});});router.patch('/:id', async (req, res) => {
  const semesterId = id(req.params.id);
  const changed = semesterPatchInput.parse(req.body);
  if (!Object.keys(changed).length) throw new ApiError(400, 'VALIDATION_ERROR', 'At least one editable field is required');
  const row = await serializable(async tx => {
    const [current] = await tx.select().from(semesters).where(eq(semesters.id, semesterId)).for('update');
    if (!current) throw new ApiError(404, 'SEMESTER_NOT_FOUND', 'Semester was not found');
    const value = semesterInput.parse({ code: changed.code ?? current.code, name: changed.name ?? current.name,
      startsOn: (changed.startsOn ?? current.startsOn).toISOString().slice(0, 10), endsOn: (changed.endsOn ?? current.endsOn).toISOString().slice(0, 10),
      registrationStartsOn: (changed.registrationStartsOn ?? current.registrationStartsOn).toISOString().slice(0, 10), registrationEndsOn: (changed.registrationEndsOn ?? current.registrationEndsOn).toISOString().slice(0, 10), status: changed.status ?? current.status });
    const [result] = await tx.update(semesters).set(value).where(eq(semesters.id, semesterId)).returning();
    if (changed.startsOn || changed.endsOn) {
      const affected = await tx.select().from(classes).where(eq(classes.semesterId, semesterId));
      for (const classroom of affected) {
        const schedules = await tx.select().from(classSchedules).where(eq(classSchedules.classId, classroom.id));
        await assertClassSchedule(tx, classroom.id, classroom.teacherId, semesterId, schedules, !classroom.archivedAt && !['cancelled','completed'].includes(classroom.lifecycleStatus));
      }
    }
    return result;
  });
  res.json({ data: row });
});router.delete('/:id',async(req,res)=>{const [r]=await db.delete(semesters).where(eq(semesters.id,id(req.params.id))).returning({id:semesters.id});if(!r)throw new ApiError(404,'SEMESTER_NOT_FOUND','Semester was not found');res.status(204).end();});export default router;
