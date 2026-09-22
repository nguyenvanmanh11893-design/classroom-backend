import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { user } from '../db/schema/auth.js';
import { ApiError } from '../lib/api-error.js';
import { writeAuditEvent } from './audit.js';

export type UpdateUserAccessInput = {
  role: UserRole | undefined;
  isActive: boolean | undefined;
};

export async function updateUserAccess(
  actorId: string,
  targetId: string,
  input: UpdateUserAccessInput,
  requestId: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('classroom_active_admin_guard'))`);

    const [target] = await tx.select({
      id: user.id,
      role: user.role,
      isActive: user.isActive,
    }).from(user).where(eq(user.id, targetId)).for('update');

    if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User was not found', { userId: targetId });

    const removesActiveAdmin = target.role === 'admin' && target.isActive && (
      input.role !== undefined && input.role !== 'admin'
      || input.isActive === false
    );

    if (removesActiveAdmin) {
      const [result] = await tx.select({ value: count() }).from(user).where(and(
        eq(user.role, 'admin'),
        eq(user.isActive, true),
      ));
      if ((result?.value ?? 0) <= 1) {
        throw new ApiError(409, 'LAST_ACTIVE_ADMIN', 'The last active admin cannot be demoted or deactivated');
      }
    }

    const [updated] = await tx.update(user).set({
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      updatedAt: new Date(),
    }).where(eq(user.id, targetId)).returning({
      id: user.id,
      role: user.role,
      isActive: user.isActive,
      updatedAt: user.updatedAt,
    });

    if (!updated) throw new ApiError(404, 'USER_NOT_FOUND', 'User was not found', { userId: targetId });

    await writeAuditEvent(tx, {
      actorId,
      entityType: 'user',
      entityId: targetId,
      action: 'user.access.updated',
      requestId,
      metadata: { before: target, after: updated },
    });

    return updated;
  }, { isolationLevel: 'serializable', accessMode: 'read write' });
}
