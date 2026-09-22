import { db } from '../db/index.js';
import { ApiError } from '../lib/api-error.js';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function retryable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ('code' in current && ['40001', '40P01'].includes(String(current.code))) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

// All class/schedule and enrollment writers use SSI so predicate reads protect
// against concurrent inserts and changes to other classes, not just this row.
export async function serializable<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await db.transaction(work, { isolationLevel: 'serializable' }); }
    catch (error) {
      if (!retryable(error)) throw error;
      if (attempt === 2) throw new ApiError(503, 'CONCURRENT_UPDATE_RETRY', 'Concurrent update; please retry');
    }
  }
  throw new Error('Unreachable transaction state');
}
