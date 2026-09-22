import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth.js';
import subjectsRoutes from './routes/subjects.js';
import usersRoutes from './routes/users.js';
import classesRoutes from './routes/classes.js';
import departmentsRoutes from './routes/departments.js';
import semestersRoutes from './routes/semesters.js';
import enrollmentsRoutes from './routes/enrollments.js';
import dashboardRoutes from './routes/dashboard.js';
import securityMiddleware from './middleware/security.js';
import { createRequireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler, requestIdMiddleware } from './lib/api-error.js';

export function createApp() {
    if (!process.env.FRONTEND_URL) throw new Error('FRONTEND_URL is not defined in the environment variables');
    const allowedOrigins = process.env.FRONTEND_URL.split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);
    const app = express();
    app.disable('x-powered-by');
    app.use(requestIdMiddleware);
    app.use(cors({
        origin: (requestOrigin, callback) => {
            if (!requestOrigin || allowedOrigins.includes(requestOrigin.replace(/\/+$/, ''))) return callback(null, true);
            callback(new Error(`Origin ${requestOrigin} is not allowed by CORS`));
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], credentials: true,
        exposedHeaders: ['x-request-id'],
    }));
    app.use('/api/auth', securityMiddleware);
    app.all('/api/auth/*splat', toNodeHandler(auth));
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', createRequireAuth());
    app.use('/api', securityMiddleware);
    app.use('/api/subjects', subjectsRoutes);
    app.use('/api/departments', departmentsRoutes);
    app.use('/api/semesters', semestersRoutes);
    app.use('/api/users', usersRoutes);
    app.use('/api/classes', classesRoutes);
    app.use('/api', enrollmentsRoutes);
    app.use('/api', dashboardRoutes);
    app.get('/', (_req, res) => res.json({ data: { service: 'classroom-backend', status: 'ok' } }));
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}
