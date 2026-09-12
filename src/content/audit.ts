/**
 * Audit trail.
 *
 * Records who did what. On a single-operator site this is not about catching
 * an insider; it is so that "when did this become public?" and "what happened
 * to that record?" have answers months later, and so that an intrusion leaves
 * traces that survive the deletion of the affected rows.
 *
 * Writing an audit entry must never fail the operation it describes, so
 * failures here are logged and swallowed.
 */
import type { FastifyBaseLogger } from 'fastify';
import { execute, type Pool, type PoolConnection } from '../db/pool.js';
import { packIpAddress } from '../auth/session.js';

export type AuditAction =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.login.locked'
  | 'auth.logout'
  | 'auth.passkey.registered'
  | 'auth.passkey.revoked'
  | 'auth.recovery.used'
  | 'auth.recovery.regenerated'
  | 'auth.password.changed'
  | 'admin.created'
  | 'source.create'
  | 'source.update'
  | 'source.delete'
  | 'source.publish'
  | 'source.unpublish'
  // An edge carries its own visibility, so publishing one is its own decision
  // and deserves its own trace -- "when did this connection become public?"
  // had no answer before.
  | 'relationship.create'
  | 'relationship.delete'
  | 'relationship.publish'
  | 'relationship.unpublish'
  | 'zotero.sync'
  | 'zotero.sync.full'
  | 'backup.requested'
  | 'place.geocode';

export interface AuditEntry {
  actor: string;
  action: AuditAction;
  itemId?: number | null;
  detail?: Record<string, unknown> | null;
  ip?: string | undefined;
}

export async function recordAudit(
  db: Pool | PoolConnection,
  entry: AuditEntry,
  logger?: FastifyBaseLogger,
): Promise<void> {
  try {
    await execute(
      db,
      'INSERT INTO audit_log (actor, action, item_id, detail, ip_address) VALUES (?, ?, ?, ?, ?)',
      [
        entry.actor.slice(0, 190),
        entry.action,
        entry.itemId ?? null,
        entry.detail === undefined || entry.detail === null ? null : JSON.stringify(entry.detail),
        packIpAddress(entry.ip),
      ],
    );
  } catch (error) {
    logger?.error({ err: error, action: entry.action }, 'failed to write audit entry');
  }
}
