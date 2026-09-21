import { and, eq, ilike, or, sql, getTableColumns, desc } from 'drizzle-orm'
import express from 'express'
import { departments, subjects } from '../db/schema/app.js'
import { db } from '../db/index.js'
const router = express.Router()
// Logic to get all subjects, pageination, and filtering can be implemented here
router.get('/', async(req, res) => {
    try{
        const { search, department, page = 1, limit = 10 } = req.query
        const currentPage = Math.max(1, parseInt(String(page), 10) || 1)
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100)
        const offset = (currentPage - 1) * limitPerPage
        const filterConditions = []
        // if search query exists, filter subjects by name or code 
        if (search) {

            filterConditions.push(
                or(
                    ilike(subjects.name, `%${search}%`),
                    ilike(subjects.code, `%${search}%`)

                )
            )    
        }
        // if department query exists, match the department name with the department query
        if (department) {
            const deptPattern = `%${String(department).replace(/[%_]/g, '\\$&')}%`
            filterConditions.push(ilike(departments.name, deptPattern))
        }
        // Combbine the filter conditions using AND operator
        const whereClause = filterConditions.length >0 ? and(...filterConditions) : undefined
        const countResult = await db.select({ count: sql<number>`count(*)` })
        .from(subjects)
        .leftJoin(departments, eq(subjects.departmentId, departments.id))
        .where(whereClause)
        const totalCount = Number(countResult[0]?.count ?? 0)

        const subjectsList = await db.select({ 
            ...getTableColumns(subjects), 
            department: { ...getTableColumns(departments) }   
         }).from(subjects)
         .leftJoin(departments, eq(subjects.departmentId, departments.id))
         .where(whereClause)
         .orderBy(desc(subjects.createdAt))
         .limit(limitPerPage)
         .offset(offset)

         res.status(200).json({
            data: subjectsList,
            pagination: {
                total: totalCount,
                page: currentPage,
                limit: limitPerPage,
                totalPages: Math.ceil(totalCount / limitPerPage)
            }
         })


    }catch(e){
        console.error(`GET /subjects error: ${e}`)
        res.status(500).json({ error: 'Failed to fetch subjects' })
    }
})

export default router

