import express from 'express'
import cors from 'cors'
import subjectsRoutes from './routes/subjects'
import securityMiddleware from './middleware/security'


const app = express()
const PORT =8000 
if (!process.env.FRONTEND_URL) throw new Error('FRONTEND_URL is not defined in the environment variables')
app.use(cors({
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}))
app.use(express.json())

app.use(securityMiddleware) 

app.use('/api/subjects', subjectsRoutes)

app.get('/', (req, res) => {
    res.send('Hello, World!')
})

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
})

