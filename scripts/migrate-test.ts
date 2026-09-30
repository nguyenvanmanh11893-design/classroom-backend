import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

if (process.env.NODE_ENV !== 'test' || !process.env.TEST_DATABASE_URL) throw new Error('Requires NODE_ENV=test and TEST_DATABASE_URL');
const target = new URL(process.env.TEST_DATABASE_URL);
if (process.env.DATABASE_URL) {
  const production = new URL(process.env.DATABASE_URL);
  if (target.hostname.replace('-pooler.', '.') === production.hostname.replace('-pooler.', '.') && target.pathname === production.pathname) throw new Error('Refusing to migrate the production database');
}
const { db, pool } = await import('../src/db/index.js');
try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Test database migrations completed. Legacy class dates and profiles still require explicit review.');
} finally { await pool.end(); }
