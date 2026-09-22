import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema/index.js';
import { auditLogs } from '../db/schema/app.js';

type AuditDatabase = Pick<NodePgDatabase<typeof schema>, 'insert'>;

const SECRET_KEYS = /password|token|secret|authorization|cookie|invite.?code|email/i;

export function redactAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditMetadata);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    SECRET_KEYS.test(key) ? '[REDACTED]' : redactAuditMetadata(entry),
  ]));
}

export async function writeAuditEvent(
  executor: AuditDatabase,
  event: {
    actorId?: string;
    entityType: string;
    entityId: string;
    action: string;
    requestId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await executor.insert(auditLogs).values({
    actorId: event.actorId,
    entityType: event.entityType,
    entityId: event.entityId,
    action: event.action,
    requestId: event.requestId,
    metadata: redactAuditMetadata(event.metadata ?? {}) as Record<string, unknown>,
  });
}
