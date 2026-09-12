/**
 * Queueing a backup.
 *
 * The point of `requestBackup` is that asking for a backup stops requiring the
 * database's root password on a command line, so these cases pin the two
 * things that makes true: the job that lands is the one the worker expects,
 * and a nightly caller cannot stack a second dump on top of a running one.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, databaseAvailable, truncateContent, type Harness } from './helpers.js';
import { execute, queryRows } from '../../src/db/pool.js';
import type { RowDataPacket } from 'mysql2/promise';
import { DEFAULT_KEEP, requestBackup } from '../../src/content/backups.js';

const available = await databaseAvailable();

describe.skipIf(!available)('backup queueing', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
  });

  async function backupJobs(): Promise<{ payload: unknown; state: string }[]> {
    const rows = await queryRows<RowDataPacket & { payload: unknown; state: string }>(
      harness.pool,
      `SELECT payload, state FROM job WHERE kind = 'backup.run' ORDER BY id`,
    );
    return rows.map((row) => ({ payload: row.payload, state: String(row.state) }));
  }

  it('queues a job the worker can read, with the retention it was given', async () => {
    expect(await requestBackup(harness.pool, { keep: 30, includeFiles: true })).toBe('queued');

    const jobs = await backupJobs();
    expect(jobs).toHaveLength(1);
    // The handler reads payload.keep and payload.includeFiles by those names.
    expect(jobs[0]?.payload).toEqual({ keep: 30, includeFiles: true });
    expect(jobs[0]?.state).toBe('pending');
  });

  it('records a database-only request distinctly', async () => {
    await requestBackup(harness.pool, { keep: DEFAULT_KEEP, includeFiles: false });
    expect(await backupJobs()).toEqual([
      { payload: { keep: DEFAULT_KEEP, includeFiles: false }, state: 'pending' },
    ]);
  });

  it('refuses to stack a second backup while one is pending', async () => {
    expect(await requestBackup(harness.pool, { keep: 14, includeFiles: true })).toBe('queued');
    expect(await requestBackup(harness.pool, { keep: 14, includeFiles: true })).toBe(
      'already_queued',
    );
    expect(await backupJobs()).toHaveLength(1);
  });

  it('refuses while one is running, which is the case cron would hit', async () => {
    await requestBackup(harness.pool, { keep: 14, includeFiles: true });
    await execute(harness.pool, `UPDATE job SET state = 'running' WHERE kind = 'backup.run'`);

    expect(await requestBackup(harness.pool, { keep: 14, includeFiles: true })).toBe(
      'already_queued',
    );
    expect(await backupJobs()).toHaveLength(1);
  });

  it('queues again once the previous backup has finished', async () => {
    await requestBackup(harness.pool, { keep: 14, includeFiles: true });
    await execute(harness.pool, `UPDATE job SET state = 'succeeded' WHERE kind = 'backup.run'`);

    expect(await requestBackup(harness.pool, { keep: 7, includeFiles: true })).toBe('queued');
    expect(await backupJobs()).toHaveLength(2);
  });

  it('is not blocked by an unrelated job kind sitting in the queue', async () => {
    await execute(
      harness.pool,
      `INSERT INTO job (kind, payload) VALUES ('zotero.sync', CAST(? AS JSON))`,
      [JSON.stringify({ full: false })],
    );

    expect(await requestBackup(harness.pool, { keep: 14, includeFiles: true })).toBe('queued');
  });
});
