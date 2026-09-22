import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

const databaseUrl = process.env.NODE_ENV === 'test'
  ? process.env.TEST_DATABASE_URL
  : process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(process.env.NODE_ENV === 'test'
    ? 'TEST_DATABASE_URL is required when NODE_ENV=test'
    : 'DATABASE_URL is not defined');
}

export const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'classroom-backend',
});

export const db = drizzle(pool, { schema });
