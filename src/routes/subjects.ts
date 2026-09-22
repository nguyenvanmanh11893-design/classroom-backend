import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import express from 'express';
import { classes, departments, subjects } from '../db/schema/app.js';
import { db } from '../db/index.js';
import { pagination, parseListQuery } from '../lib/list-query.js';
import { ApiError } from '../lib/api-error.js';
import { requireRole } from '../middleware/auth.js';
import { z } from 'zod';

const router = express.Router();

router.get('/', async (req, res) => {
    const list = parseListQuery(req.query, ['id', 'name', 'code', 'createdAt']);
    const filters = [];
    if (list.search) filters.push(or(ilike(subjects.name, `%${list.search}%`), ilike(subjects.code, `%${list.search}%`)));
    if (req.query.department) {
        const department = String(req.query.department).slice(0, 200);
        filters.push(ilike(departments.name, `%${department.replace(/[%_]/g, '\\$&')}%`));
    }
    const where = filters.length ? and(...filters) : undefined;
    const sortColumns = { id: subjects.id, name: subjects.name, code: subjects.code, createdAt: subjects.createdAt } as const;
    const sort = list.order === 'asc' ? asc : desc;
    const [countResult, rows] = await Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(subjects).leftJoin(departments, eq(subjects.departmentId, departments.id)).where(where),
        db.select({
            id: subjects.id, name: subjects.name, code: subjects.code, description: subjects.description,
            createdAt: subjects.createdAt, updatedAt: subjects.updatedAt,
            department: { id: departments.id, name: departments.name, code: departments.code, description: departments.description },
        }).from(subjects).leftJoin(departments, eq(subjects.departmentId, departments.id)).where(where)
          .orderBy(sort(sortColumns[list.sort as keyof typeof sortColumns]), asc(subjects.id))
          .limit(list.pageSize).offset(list.offset),
    ]);
    const total = Number(countResult[0]?.count ?? 0);
    res.json({ data: rows, pagination: pagination(total, list) });
});

router.get('/:id', async (req,res) => { const subjectId=z.coerce.number().int().positive().parse(req.params.id); const [row]=await db.select({ id:subjects.id,name:subjects.name,code:subjects.code,description:subjects.description,createdAt:subjects.createdAt,updatedAt:subjects.updatedAt,department:{id:departments.id,name:departments.name,code:departments.code} }).from(subjects).leftJoin(departments,eq(subjects.departmentId,departments.id)).where(eq(subjects.id,subjectId)); if(!row)throw new ApiError(404,'SUBJECT_NOT_FOUND','Subject was not found');res.json({data:row}); });
const subjectInput=z.object({departmentId:z.coerce.number().int().positive(),name:z.string().trim().min(1).max(255),code:z.string().trim().min(1).max(50),description:z.string().trim().max(255).nullable().optional()}).strict();
async function ensureDepartment(departmentId:number){const [department]=await db.select({id:departments.id}).from(departments).where(eq(departments.id,departmentId));if(!department)throw new ApiError(400,'DEPARTMENT_INVALID','Department does not exist',{departmentId});}
router.post('/',requireRole('admin'),async(req,res)=>{const data=subjectInput.parse(req.body);await ensureDepartment(data.departmentId);const [existing]=await db.select({id:subjects.id}).from(subjects).where(eq(subjects.code,data.code));if(existing)throw new ApiError(409,'SUBJECT_CODE_IN_USE','Subject code is already in use');const [row]=await db.insert(subjects).values(data).returning();res.status(201).json({data:row});});
router.patch('/:id',requireRole('admin'),async(req,res)=>{const subjectId=z.coerce.number().int().positive().parse(req.params.id);const data=subjectInput.partial().parse(req.body);if(data.departmentId)await ensureDepartment(data.departmentId);const [row]=await db.update(subjects).set(data).where(eq(subjects.id,subjectId)).returning();if(!row)throw new ApiError(404,'SUBJECT_NOT_FOUND','Subject was not found');res.json({data:row});});
router.delete('/:id',requireRole('admin'),async(req,res)=>{const subjectId=z.coerce.number().int().positive().parse(req.params.id);const [inUse]=await db.select({value:count()}).from(classes).where(eq(classes.subjectId,subjectId));if(Number(inUse?.value??0))throw new ApiError(409,'SUBJECT_IN_USE','Subject has classes and cannot be deleted');const [row]=await db.delete(subjects).where(eq(subjects.id,subjectId)).returning({id:subjects.id});if(!row)throw new ApiError(404,'SUBJECT_NOT_FOUND','Subject was not found');res.status(204).end();});

export default router;
