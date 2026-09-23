import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { pool } from '../src/db/index.js';
import { assignmentInput, assignSemester, previewSemesterAssignment } from '../src/services/semester-assignment.js';

const args = process.argv.slice(2);
const filename = args.find(arg => !arg.startsWith('--'));
const apply = args.includes('--apply');
try {
  if (!filename || args.some(arg => arg.startsWith('--') && arg !== '--apply')) throw new Error('Usage: npm run db:assign-semester -- path/to/assignment.json [--apply]');
  const config = assignmentInput.parse(JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')));
  const target = process.env.NODE_ENV === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const result = apply ? await assignSemester(config) : await previewSemesterAssignment(config);
  console.log(JSON.stringify({ mode: apply ? 'APPLIED' : 'READ_ONLY_PREVIEW', target, ...result }, null, 2));
} catch (error) {
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  console.error(error instanceof z.ZodError ? error.issues : error instanceof Error && !('query' in error) ? error.message : `Database operation failed (${code ?? 'UNKNOWN'}).`);
  process.exitCode = 1;
} finally { await pool.end(); }
