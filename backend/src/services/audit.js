// Append-only audit trail for sensitive actions.
import { prisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';

const MAX_JSON_CHARS = 8_000;

function compact(value) {
  if (value === undefined || value === null) return undefined;
  try {
    const json = JSON.stringify(value);
    if (json.length <= MAX_JSON_CHARS) return JSON.parse(json);
    return { truncated: true, preview: json.slice(0, MAX_JSON_CHARS) };
  } catch {
    return undefined;
  }
}

/**
 * Record an audit entry.
 *
 * @param {import('express').Request | { user?: { id: string, role: string }, ip?: string }} ctx
 * @param {{ action: string, entityType: string, entityId?: string | null, classId?: string | null,
 *           summary?: string, before?: unknown, after?: unknown }} entry
 * @param {object} [tx] pass the transaction client to make the entry atomic with the change
 */
export async function audit(ctx, entry, tx) {
  const data = {
    actorId: ctx?.user?.id ?? null,
    actorRole: ctx?.user?.role ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    classId: entry.classId ?? null,
    summary: entry.summary ? String(entry.summary).slice(0, 500) : null,
    before: compact(entry.before),
    after: compact(entry.after),
    ipAddress: ctx?.ip ?? null,
  };
  if (tx) {
    // Inside a transaction a failed audit write must fail the whole change.
    await tx.auditLog.create({ data });
    return;
  }
  try {
    await prisma.auditLog.create({ data });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'failed to write audit log entry');
  }
}
