import { and, eq, ilike, or, sql, getTableColumns, desc, SQL } from 'drizzle-orm'
import express from 'express'
import { user } from '../db/schema/auth.js'
import { db } from '../db/index.js'

const router = express.Router()

router.get('/', async (req, res) => {
    try {
        const { search, role, page = 1, limit = 10 } = req.query
        const currentPage = Math.max(1, parseInt(String(page), 10) || 1)
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100)
        const offset = (currentPage - 1) * limitPerPage
        const filterConditions: SQL[] = []

        if (search) {
            const searchCondition = or(
                ilike(user.name, `%${search}%`),
                ilike(user.email, `%${search}%`)
            )
            if (searchCondition) filterConditions.push(searchCondition)
        }

        if (role) {
            const roleValue = String(role)
            if (roleValue === 'student' || roleValue === 'teacher' || roleValue === 'admin') {
                filterConditions.push(eq(user.role, roleValue))
            }
        }

        const whereClause = filterConditions.length > 0 ? and(...filterConditions) : undefined
        const countResult = await db.select({ count: sql<number>`count(*)` })
            .from(user)
            .where(whereClause)
        const totalCount = Number(countResult[0]?.count ?? 0)

        const usersList = await db.select({
            ...getTableColumns(user),
        })
            .from(user)
            .where(whereClause)
            .orderBy(desc(user.createdAt))
            .limit(limitPerPage)
            .offset(offset)

        res.status(200).json({
            data: usersList,
            pagination: {
                total: totalCount,
                page: currentPage,
                limit: limitPerPage,
                totalPages: Math.ceil(totalCount / limitPerPage)
            }
        })
    } catch (e) {
        console.error(`GET /users error: ${e}`)
        res.status(500).json({ error: 'Failed to fetch users' })
    }
})

export default router
