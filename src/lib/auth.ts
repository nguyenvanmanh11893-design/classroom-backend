import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import * as schema from '../db/schema/auth.js'

const trustedOrigins = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean)

export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:8000',
    trustedOrigins,
    secret: process.env.BETTER_AUTH_SECRET!,
    database: drizzleAdapter(db, {
        provider: "pg",
        schema,
    }),

    emailAndPassword: {
        enabled: true,
    },
    user: {
        additionalFields: {
            role: {
                type: "string", required: true, defaultValue: "student", input: false,
            },
            imageCldPubId: {
                type: "string", required: false, input: true,
            },
        }
    }
});
