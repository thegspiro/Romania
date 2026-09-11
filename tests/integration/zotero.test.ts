/**
 * Queuing a Zotero sync, end to end through HTTP and MySQL.
 *
 * The Zotero API itself is the worker's business and is covered by
 * worker/tests/test_zotero_sync.py. What has to hold here is everything a
 * route can get wrong: that the button is behind the admin guard, that it
 * carries a CSRF token, that a missing configuration says so instead of
 * queuing work nothing can run, and that the link table's constraints are the
 * ones the sync relies on to be an upsert rather than an append.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import {
  createHarness,
  databaseAvailable,
  getPage,
  postForm,
  signIn,
  sourceForm,
  truncateContent,
  type Harness,
} from './helpers.js';
import { execute, queryOne, queryRows } from '../../src/db/pool.js';
import {
  configuredLibrary,
  findSyncState,
  listZoteroDeletedSourceIds,
  requestZoteroSync,
} from '../../src/content/zotero.js';

const available = await databaseAvailable();

const LIBRARY = { libraryType: 'user', libraryId: '12345' } as const;

describe.skipIf(!available)('zotero sync', () => {
  let harness: Harness;
  let admin: Map<string, string>;

  beforeAll(async () => {
    harness = await createHarness({ ZOTERO_LIBRARY_ID: '12345' });
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
    admin = await signIn(harness);
  });

  async function createSource(fields: Record<string, string> = {}): Promise<number> {
    const page = await getPage(harness, '/admin/sources/new', admin);
    const result = await postForm(harness, '/admin/sources', admin, {
      ...sourceForm(fields),
      _csrf: page.csrf,
    });
    const id = /\/admin\/sources\/(\d+)\/edit/.exec(result.location ?? '')?.[1];
    if (id === undefined) throw new Error(`create failed: ${result.statusCode}`);
    return Number(id);
  }

  /** The payload column comes back as JSON or as its text, depending on driver
   *  settings; both are narrowed from `unknown` rather than cast. */
  function payloadOf(row: RowDataPacket | undefined): unknown {
    const raw: unknown = row?.payload;
    return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  }

  async function queuedJobs(): Promise<RowDataPacket[]> {
    return queryRows<RowDataPacket>(
      harness.pool,
      `SELECT kind, payload, state FROM job WHERE kind = 'zotero.sync' ORDER BY id`,
    );
  }

  // --- The route -----------------------------------------------------------

  it('queues a sync job from the sources page', async () => {
    const page = await getPage(harness, '/admin/sources', admin);
    const result = await postForm(harness, '/admin/sources/zotero-sync', admin, {
      _csrf: page.csrf,
    });

    expect(result.location).toBe('/admin/sources?msg=zotero_queued');

    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe('pending');
    expect(payloadOf(jobs[0])).toEqual({ full: false });
  });

  it('carries the full-resync flag into the payload', async () => {
    const page = await getPage(harness, '/admin/sources', admin);
    await postForm(harness, '/admin/sources/zotero-sync', admin, {
      _csrf: page.csrf,
      full: 'on',
    });

    const jobs = await queuedJobs();
    expect(payloadOf(jobs[0])).toEqual({ full: true });
  });

  it('does not queue a second sync while one is waiting', async () => {
    const page = await getPage(harness, '/admin/sources', admin);
    await postForm(harness, '/admin/sources/zotero-sync', admin, { _csrf: page.csrf });
    const second = await postForm(harness, '/admin/sources/zotero-sync', admin, {
      _csrf: page.csrf,
    });

    expect(second.location).toBe('/admin/sources?msg=zotero_already_queued');
    expect(await queuedJobs()).toHaveLength(1);
  });

  it('queues again once the previous sync has finished', async () => {
    await requestZoteroSync(harness.pool, { full: false });
    await execute(harness.pool, `UPDATE job SET state = 'succeeded' WHERE kind = 'zotero.sync'`);

    expect(await requestZoteroSync(harness.pool, { full: false })).toBe('queued');
    expect(await queuedJobs()).toHaveLength(2);
  });

  it('refuses a request without a CSRF token', async () => {
    const result = await postForm(harness, '/admin/sources/zotero-sync', admin, {});

    expect(result.statusCode).toBe(403);
    expect(await queuedJobs()).toHaveLength(0);
  });

  it('is not reachable without a session', async () => {
    const result = await postForm(harness, '/admin/sources/zotero-sync', new Map(), {});

    expect(result.statusCode).toBeGreaterThanOrEqual(300);
    expect(await queuedJobs()).toHaveLength(0);
  });

  // --- The link table ------------------------------------------------------

  it('refuses two sources claiming the same Zotero item', async () => {
    const first = await createSource({ title: 'Anii' });
    const second = await createSource({ title: 'Alți ani' });

    await link(first, 'ITEMKEY1');
    // The uniqueness that turns a sync into an upsert. Without it a retried
    // sync would import the same item twice.
    await expect(link(second, 'ITEMKEY1')).rejects.toThrow(/Duplicate/i);
  });

  it('lets one source be linked to one item only', async () => {
    const id = await createSource({ title: 'Anii' });
    await link(id, 'ITEMKEY1');
    await expect(link(id, 'ITEMKEY2')).rejects.toThrow(/Duplicate/i);
  });

  it('drops the link when the source is deleted', async () => {
    const id = await createSource({ title: 'Anii' });
    await link(id, 'ITEMKEY1');

    await execute(harness.pool, 'DELETE FROM content_item WHERE id = ?', [id]);

    const remaining = await queryOne<RowDataPacket & { total: number }>(
      harness.pool,
      'SELECT COUNT(*) AS total FROM source_zotero_link',
    );
    expect(Number(remaining?.total)).toBe(0);
  });

  it('reports a deleted item without touching the source', async () => {
    const id = await createSource({ title: 'Anii' });
    await link(id, 'ITEMKEY1');
    await execute(
      harness.pool,
      'UPDATE source_zotero_link SET deleted_in_zotero_at = NOW(3) WHERE content_item_id = ?',
      [id],
    );

    expect(await listZoteroDeletedSourceIds(harness.pool)).toEqual([id]);

    // The source survives: it may already be cited, and removing it would
    // leave a dangling [[cite:...]] in prose that has been written.
    const source = await queryOne<RowDataPacket & { title: string }>(
      harness.pool,
      'SELECT title FROM content_item WHERE id = ?',
      [id],
    );
    expect(source?.title).toBe('Anii');
  });

  it('has no sync state before the first run', async () => {
    expect(await findSyncState(harness.pool, LIBRARY)).toBeNull();
  });

  it('reads back the state a completed sync recorded', async () => {
    await execute(
      harness.pool,
      `INSERT INTO zotero_library_state
         (library_type, library_id, last_version, last_synced_at,
          created_count, updated_count, linked_count, deleted_count)
       VALUES (?, ?, 4210, NOW(3), 12, 3, 5, 1)`,
      [LIBRARY.libraryType, LIBRARY.libraryId],
    );

    const state = await findSyncState(harness.pool, LIBRARY);
    expect(state?.lastVersion).toBe(4210);
    expect(state?.createdCount).toBe(12);
    expect(state?.linkedCount).toBe(5);
    expect(state?.lastSyncedAt).toBeInstanceOf(Date);
  });

  async function link(contentItemId: number, itemKey: string): Promise<void> {
    await execute(
      harness.pool,
      `INSERT INTO source_zotero_link
         (content_item_id, library_type, library_id, item_key, item_version)
       VALUES (?, ?, ?, ?, 1)`,
      [contentItemId, LIBRARY.libraryType, LIBRARY.libraryId, itemKey],
    );
  }
});

/**
 * A separate suite because `createHarness` migrates the database down to zero
 * and back up, so two harnesses must never be live at once. Vitest runs the
 * suites in a file one after another, which is exactly the guarantee needed.
 */
describe.skipIf(!available)('zotero sync, unconfigured', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('says so rather than queuing work nothing can run', async () => {
    await truncateContent(harness.pool);
    const cookies = await signIn(harness);
    const page = await getPage(harness, '/admin/sources', cookies);

    const result = await postForm(harness, '/admin/sources/zotero-sync', cookies, {
      _csrf: page.csrf,
    });

    expect(result.location).toBe('/admin/sources?msg=zotero_unconfigured');
    expect(configuredLibrary(harness.config)).toBeNull();

    const jobs = await queryRows<RowDataPacket>(
      harness.pool,
      `SELECT id FROM job WHERE kind = 'zotero.sync'`,
    );
    expect(jobs).toHaveLength(0);
  });

  it('offers no sync control on the sources page', async () => {
    const cookies = await signIn(harness);
    const page = await getPage(harness, '/admin/sources', cookies);
    expect(page.body).not.toContain('zotero-sync');
  });
});
