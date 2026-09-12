/**
 * Backups, from the web service's side.
 *
 * The same division of labour as compilation and Zotero sync: this module
 * decides that a backup should happen and records it; `worker/jobs/backup.py`
 * is the only thing that runs mysqldump and writes to BACKUP_ROOT.
 *
 * It exists so that asking for a backup does not mean asking the operator to
 * hand-write an INSERT as the database's root user. That was the documented
 * procedure, and it put the root password into shell history and into the
 * process list of whatever host ran it -- a cost paid nightly by anyone who
 * followed the README and put the statement in cron.
 *
 * Administrative bookkeeping, not content, so nothing here takes a `Viewer`:
 * the only caller is the CLI, which already requires shell access to the
 * container.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { execute, queryOne, withTransaction, type Pool } from '../db/pool.js';

/** Matches DEFAULT_KEEP in worker/jobs/backup.py. */
export const DEFAULT_KEEP = 14;

/** The worker rejects anything outside this; rejecting it here fails sooner. */
export const MIN_KEEP = 1;
export const MAX_KEEP = 365;

export class InvalidRetentionError extends Error {
  public constructor(value: string) {
    super(
      `--keep must be a whole number between ${MIN_KEEP} and ${MAX_KEEP}, got "${value}". ` +
        'It is how many of each backup kind to keep, not a number of days.',
    );
    this.name = 'InvalidRetentionError';
  }
}

/** Parses and validates a `--keep` argument. */
export function parseRetention(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_KEEP;
  if (!/^\d+$/.test(raw)) throw new InvalidRetentionError(raw);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_KEEP || value > MAX_KEEP) {
    throw new InvalidRetentionError(raw);
  }
  return value;
}

export interface BackupRequest {
  keep: number;
  includeFiles: boolean;
}

export type BackupRequestOutcome = 'queued' | 'already_queued';

/**
 * Queues a backup, unless one is already waiting or running.
 *
 * The guard matters more here than it does for a sync: a nightly cron firing
 * while a large dump is still going would otherwise stack jobs that each hold
 * a mysqldump open, and the second one's output is worth nothing the first did
 * not already have. Like the Zotero guard it is a convenience rather than a
 * lock -- two callers arriving together can both find the queue empty -- but
 * the failure it prevents is a real one and the duplicate it allows is rare.
 */
export async function requestBackup(
  pool: Pool,
  request: BackupRequest,
): Promise<BackupRequestOutcome> {
  return withTransaction(pool, async (connection) => {
    const pending = await queryOne<RowDataPacket & { id: number }>(
      connection,
      `SELECT id FROM job
        WHERE kind = 'backup.run' AND state IN ('pending', 'running')
        LIMIT 1`,
    );
    if (pending !== null) return 'already_queued';

    await execute(
      connection,
      `INSERT INTO job (kind, payload) VALUES ('backup.run', CAST(? AS JSON))`,
      [JSON.stringify({ keep: request.keep, includeFiles: request.includeFiles })],
    );
    return 'queued';
  });
}
