import type { Request, Response, NextFunction } from "express"
import aj from '../config/arcjet.js'
import { ArcjetNodeRequest, slidingWindow } from "@arcjet/node"
import { ApiError } from '../lib/api-error.js'
const securityMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === "test") return next()
    
    try {
        const role: RateLimitRole = req.user?.role ?? 'guest'

        let limit: number
        let message: string

        switch (role) {
            case "admin":
                limit= 50
                message= 'Admin request limit exceeded (50 per minute). Slow down'
                break
            case "teacher":
            case "student":
                limit= 40
                message= 'User request limit exceeded (40 per minute). Please wait'
                break
            default:
                limit= 30
                message= 'Guest request limit exceeded (30 per minute). Please sign up for higher limits.'
                break
        }

        const client = aj.withRule(
            slidingWindow({
                mode: 'LIVE',
                interval: '1m', // 1 minute
                max: limit, // Max requests per window
            })
        )

        const arcjetRequest: ArcjetNodeRequest = {
            headers: req.headers,
            method: req.method,
            url: req.originalUrl ?? req.url,
            socket: { remoteAddress: req.socket.remoteAddress ?? req.ip ?? '0.0.0.0' },
        }

        const decision = await client.protect(arcjetRequest)

        if(decision.isDenied() && decision.reason.isBot()) {
            return next(new ApiError(403, 'BOT_BLOCKED', 'Automated requests are not allowed'))
        }

        if(decision.isDenied() && decision.reason.isShield()) {
            return next(new ApiError(403, 'SECURITY_POLICY_BLOCKED', 'Request blocked by security policy'))
        }

        if(decision.isDenied() && decision.reason.isRateLimit()) {
            return next(new ApiError(429, 'RATE_LIMITED', message))
        }
        
        next()
    } catch (e) {
        console.error('Arcjet middleware error', e)
        next(new ApiError(500, 'SECURITY_SERVICE_ERROR', 'Security service failed'))
    }
}

export default securityMiddleware
