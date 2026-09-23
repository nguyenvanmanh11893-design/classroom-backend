import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';

if (process.env.NODE_ENV !== 'test' || !process.env.TEST_DATABASE_URL) throw new Error('Seed requires NODE_ENV=test and TEST_DATABASE_URL');
const target = new URL(process.env.TEST_DATABASE_URL);
if (process.env.DATABASE_URL) {
  const production = new URL(process.env.DATABASE_URL);
  if (target.hostname.replace('-pooler.', '.') === production.hostname.replace('-pooler.', '.') && target.pathname === production.pathname) throw new Error('Refusing production database');
}
const { db, pool } = await import('../src/db/index.js');
const { auth } = await import('../src/lib/auth.js');
const { user } = await import('../src/db/schema/auth.js');
const { departments, subjects, semesters } = await import('../src/db/schema/app.js');
try {
  const suffix = randomBytes(4).toString('hex');
  const accounts = [];
  for (const role of ['admin', 'teacher', 'student'] as const) {
    const email = `local-${role}-${suffix}@example.test`;
    const password = `${randomBytes(18).toString('base64url')}!1a`;
    const result = await auth.api.signUpEmail({ body: { name: `Local ${role} ${suffix}`, email, password } });
    await db.update(user).set({ role, preferredLocale: 'vi' }).where(eq(user.id, result.user.id));
    accounts.push({ id: result.user.id, role, email, password });
  }
  const [department] = await db.insert(departments).values({ name: `Local QA ${suffix}`, code: `QA-${suffix}` }).returning();
  const [subject] = await db.insert(subjects).values({ name: `Local subject ${suffix}`, code: `QA-${suffix}`, departmentId: department!.id }).returning();
  const year = new Date().getUTCFullYear();
  const [semester] = await db.insert(semesters).values({ code: `LOCAL-${suffix}`, name: `Local semester ${year}`, startsOn: new Date(`${year}-01-01`), endsOn: new Date(`${year}-12-31`), registrationStartsOn: new Date(`${year}-01-01`), registrationEndsOn: new Date(`${year}-12-31`), status: 'active' }).returning();
  await writeFile('local-test-accounts.json', JSON.stringify({ environment: 'TEST_DATABASE_URL only', accounts, departmentId: department!.id, subjectId: subject!.id, semesterId: semester!.id }, null, 2));
  console.log('Test accounts and catalog created. Credentials: local-test-accounts.json (gitignored).');
} finally { await pool.end(); }
