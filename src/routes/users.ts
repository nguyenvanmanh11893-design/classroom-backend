import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import express from 'express';
import { z } from 'zod';
import { user } from '../db/schema/auth.js';
import { db } from '../db/index.js';
import { requireRole } from '../middleware/auth.js';
import { pagination, parseListQuery } from '../lib/list-query.js';
import { updateUserAccess } from '../services/users.js';
import { ApiError } from '../lib/api-error.js';
import { auth } from '../lib/auth.js';

const router = express.Router();

const preferredLocaleSchema = z.object({ preferredLocale: z.enum(['en', 'vi']) }).strict();

// This endpoint intentionally precedes the admin guard: every authenticated user owns this field.
router.patch('/me/preferences', async (req, res) => {
    const input = preferredLocaleSchema.parse(req.body);
    const [updated] = await db.update(user).set({ preferredLocale: input.preferredLocale, updatedAt: new Date() })
        .where(eq(user.id, req.user!.id)).returning({ preferredLocale: user.preferredLocale });
    if (!updated) throw new Error('Authenticated user no longer exists');
    res.json({ data: updated });
});

router.use(requireRole('admin'));

router.get('/', async (req, res) => {
    const list = parseListQuery(req.query, ['id', 'name', 'email', 'role', 'createdAt']);
    const roleResult = z.enum(['student', 'teacher', 'admin']).optional().safeParse(req.query.role);
    if (!roleResult.success) throw roleResult.error;
    const filters = [];
    if (list.search) filters.push(or(ilike(user.name, `%${list.search}%`), ilike(user.email, `%${list.search}%`)));
    if (roleResult.data) filters.push(eq(user.role, roleResult.data));
    if (req.query.status) filters.push(eq(user.isActive, z.enum(['active','inactive']).parse(req.query.status) === 'active'));
    const where = filters.length ? and(...filters) : undefined;
    const sortColumns = { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt } as const;
    const sort = list.order === 'asc' ? asc : desc;
    const [countResult, rows] = await Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(user).where(where),
        db.select({
            id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified,
            role: user.role, isActive: user.isActive, preferredLocale: user.preferredLocale,
            image: user.image, createdAt: user.createdAt, updatedAt: user.updatedAt,
        }).from(user).where(where)
          .orderBy(sort(sortColumns[list.sort as keyof typeof sortColumns]), asc(user.id))
          .limit(list.pageSize).offset(list.offset),
    ]);
    const total = Number(countResult[0]?.count ?? 0);
    res.json({ data: rows, pagination: pagination(total, list) });
});
router.get('/:id', async(req,res)=>{const [row]=await db.select({id:user.id,name:user.name,email:user.email,emailVerified:user.emailVerified,role:user.role,isActive:user.isActive,preferredLocale:user.preferredLocale,image:user.image,createdAt:user.createdAt,updatedAt:user.updatedAt}).from(user).where(eq(user.id,req.params.id));if(!row)throw new ApiError(404,'USER_NOT_FOUND','User was not found');res.json({data:row});});
const provisionSchema=z.object({name:z.string().trim().min(1).max(255),email:z.email().max(320),password:z.string().min(8).max(128),role:z.enum(['student','teacher','admin']).default('student'),preferredLocale:z.enum(['en','vi']).default('en')}).strict();
router.post('/',async(req,res)=>{const input=provisionSchema.parse(req.body);const [existing]=await db.select({id:user.id}).from(user).where(eq(user.email,input.email));if(existing)throw new ApiError(409,'EMAIL_IN_USE','Email is already in use');const result=await (auth.api as any).signUpEmail({body:{name:input.name,email:input.email,password:input.password}});const created=result?.user;if(!created?.id)throw new ApiError(500,'USER_PROVISION_FAILED','User could not be provisioned');const [row]=await db.update(user).set({role:input.role,preferredLocale:input.preferredLocale}).where(eq(user.id,created.id)).returning({id:user.id,name:user.name,email:user.email,role:user.role,isActive:user.isActive,preferredLocale:user.preferredLocale,createdAt:user.createdAt});res.status(201).json({data:row});});
const profileSchema=z.object({name:z.string().trim().min(1).max(255),preferredLocale:z.enum(['en','vi']).optional()}).strict();
router.patch('/:id',async(req,res)=>{const data=profileSchema.partial().parse(req.body);if(!Object.keys(data).length)throw new ApiError(400,'VALIDATION_ERROR','At least one editable field is required');const [row]=await db.update(user).set(data).where(eq(user.id,req.params.id)).returning({id:user.id,name:user.name,email:user.email,role:user.role,isActive:user.isActive,preferredLocale:user.preferredLocale});if(!row)throw new ApiError(404,'USER_NOT_FOUND','User was not found');res.json({data:row});});

const updateAccessSchema = z.object({
    role: z.enum(['student', 'teacher', 'admin']).optional(),
    isActive: z.boolean().optional(),
}).strict().refine((value) => value.role !== undefined || value.isActive !== undefined, {
    message: 'At least one access field is required',
});

router.patch('/:id/access', async (req, res) => {
    const input = updateAccessSchema.parse(req.body);
    const updated = await updateUserAccess(req.user!.id, req.params.id, {
        role: input.role,
        isActive: input.isActive,
    }, req.requestId);
    res.json({ data: updated });
});

export default router;
