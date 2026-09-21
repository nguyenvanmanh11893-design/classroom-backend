import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import * as schema from '../db/schema/auth.js'

export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:8000',
    trustedOrigins: process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [],
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
