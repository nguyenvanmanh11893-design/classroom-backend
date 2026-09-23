import express from 'express';
import { and, asc, desc, eq, ilike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { departments, subjects } from '../db/schema/app.js';
import { ApiError } from '../lib/api-error.js';
import { pagination, parseListQuery } from '../lib/list-query.js';
import { requireRole } from '../middleware/auth.js';

const router = express.Router();
const input = z.object({ code: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(255), description: z.string().trim().max(255).nullable().optional() }).strict();
const id = (value: unknown) => z.coerce.number().int().positive().parse(value);
router.get('/', async (req,res) => { const q=parseListQuery(req.query,['id','code','name','createdAt']); const where=q.search?and(ilike(departments.name,`%${q.search}%`)):undefined; const cols={id:departments.id,code:departments.code,name:departments.name,createdAt:departments.createdAt} as const; const order=q.order==='asc'?asc:desc; const [c,data]=await Promise.all([db.select({count:sql<number>`count(*)`}).from(departments).where(where),db.select().from(departments).where(where).orderBy(order(cols[q.sort as keyof typeof cols]),asc(departments.id)).limit(q.pageSize).offset(q.offset)]); res.json({data,pagination:pagination(Number(c[0]?.count??0),q)}); });
router.get('/:id',async(req,res)=>{const [row]=await db.select().from(departments).where(eq(departments.id,id(req.params.id)));if(!row)throw new ApiError(404,'DEPARTMENT_NOT_FOUND','Department was not found');res.json({data:row});});
router.post('/',requireRole('admin'),async(req,res)=>{const data=input.parse(req.body);const [existing]=await db.select({id:departments.id}).from(departments).where(eq(departments.code,data.code));if(existing)throw new ApiError(409,'DEPARTMENT_CODE_IN_USE','Department code is already in use');try { const [row]=await db.insert(departments).values(data).returning();res.status(201).json({data:row}); } catch (error) { throw error; }});
router.patch('/:id',requireRole('admin'),async(req,res)=>{const [row]=await db.update(departments).set(input.partial().parse(req.body)).where(eq(departments.id,id(req.params.id))).returning();if(!row)throw new ApiError(404,'DEPARTMENT_NOT_FOUND','Department was not found');res.json({data:row});});
router.delete('/:id',requireRole('admin'),async(req,res)=>{const departmentId=id(req.params.id);const [used]=await db.select({count:sql<number>`count(*)`}).from(subjects).where(eq(subjects.departmentId,departmentId));if(Number(used?.count??0))throw new ApiError(409,'DEPARTMENT_IN_USE','Department has subjects and cannot be deleted');const [row]=await db.delete(departments).where(eq(departments.id,departmentId)).returning({id:departments.id});if(!row)throw new ApiError(404,'DEPARTMENT_NOT_FOUND','Department was not found');res.status(204).end();});
export default router;
