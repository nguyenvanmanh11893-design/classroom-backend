import AgentAPI from "apminsight"
AgentAPI.config()
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import subjectsRoutes from './routes/subjects.js'
import usersRoutes from './routes/users.js'
import classesRoutes from './routes/classes.js'
import securityMiddleware from './middleware/security.js'
import { auth } from './lib/auth.js'
import { toNodeHandler } from 'better-auth/node'


const app = express()
const PORT =8000 
if (!process.env.FRONTEND_URL) throw new Error('FRONTEND_URL is not defined in the environment variables')
app.use(cors({
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}))

app.all('/api/auth/*splat', toNodeHandler(auth))

app.use(express.json())

app.use(securityMiddleware) 

app.use('/api/subjects', subjectsRoutes)
app.use('/api/users', usersRoutes)
app.use('/api/classes', classesRoutes)

app.get('/', (req, res) => {
    res.send('Hello, World!')
})

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
})
