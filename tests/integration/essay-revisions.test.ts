/**
 * Essay revision history, end to end through HTTP and MySQL.
 *
 * Prose is the only content here that exists nowhere else, so what has to hold
 * is: every save that changes something is recorded, a revision is written in
 * the same transaction as the text it describes, nothing rewrites history, and
 * restoring never republishes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import {
  createHarness,
  databaseAvailable,
  getPage,
  postForm,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { execute, queryOne, queryRows } from '../../src/db/pool.js';
import {
  countEssayRevisions,
  findEssayById,
  findEssayRevision,
  findPreviousRevision,
  listEssayRevisions,
} from '../../src/content/essays.js';
import { adminViewer } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('essay revisions', () => {
  let harness: Harness;
  let admin: Map<string, string>;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
    admin = await signIn(harness);
  });

  function essayForm(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      title: 'The Commission Meets',
      titleOriginal: '',
      language: '',
      summary: '',
      visibility: 'private',
      bodyMarkdown: 'The commission met in July.',
      status: 'draft',
      ...overrides,
    };
  }

  async function create(overrides: Record<string, string> = {}): Promise<number> {
    const page = await getPage(harness, '/admin/essays/new', admin);
    const result = await postForm(harness, '/admin/essays', admin, {
      ...essayForm(overrides),
      _csrf: page.csrf,
    });
    const id = /\/admin\/essays\/(\d+)\/edit/.exec(result.location ?? '')?.[1];
    if (id === undefined) throw new Error(`create failed: ${result.statusCode}`);
    return Number(id);
  }

  async function save(id: number, overrides: Record<string, string>): Promise<void> {
    const page = await getPage(harness, `/admin/essays/${id}/edit`, admin);
    const result = await postForm(harness, `/admin/essays/${id}`, admin, {
      ...essayForm(overrides),
      _csrf: page.csrf,
    });
    if (result.location === undefined) throw new Error(`save failed: ${result.statusCode}`);
  }

  // --- Recording -----------------------------------------------------------

  it('records the first revision when an essay is created', async () => {
    const id = await create();

    const revisions = await listEssayRevisions(harness.pool, id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revisionNumber: 1, source: 'save', restoredFrom: null });
  });

  it('appends a revision for each save that changes the prose', async () => {
    const id = await create();
    await save(id, { bodyMarkdown: 'The commission met in August.' });
    await save(id, { bodyMarkdown: 'The commission met in September.' });

    const revisions = await listEssayRevisions(harness.pool, id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
  });

  it('does not record a save that changed nothing', async () => {
    // Pressing Save on an untouched form would otherwise bury the real edits.
    const id = await create();
    await save(id, {});
    await save(id, {});

    expect(await countEssayRevisions(harness.pool, id)).toBe(1);
  });

  it('records a title change even when the prose is untouched', async () => {
    const id = await create();
    await save(id, { title: 'The Commission Reconvenes' });

    const revisions = await listEssayRevisions(harness.pool, id);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.title).toBe('The Commission Reconvenes');
  });

  it('records a status change', async () => {
    const id = await create();
    await save(id, { status: 'in_review' });

    expect(await countEssayRevisions(harness.pool, id)).toBe(2);
    expect((await listEssayRevisions(harness.pool, id))[0]?.status).toBe('in_review');
  });

  it('keeps the newest revision equal to the current text', async () => {
    // The property the whole design rests on: the head of the history is the
    // essay. Without it, "restore revision N" would be off by one.
    const id = await create();
    await save(id, { bodyMarkdown: 'Rewritten entirely.', title: 'A New Title' });

    const essay = await findEssayById(harness.pool, id, adminViewer(harness.userId));
    const newest = (await listEssayRevisions(harness.pool, id))[0];
    const full = await findEssayRevision(harness.pool, id, newest?.revisionNumber ?? 0);

    expect(full?.bodyMarkdown).toBe(essay?.bodyMarkdown);
    expect(full?.title).toBe(essay?.title);
    expect(full?.status).toBe(essay?.status);
  });

  it('stores the revision in the same transaction as the prose', async () => {
    // A revision written outside the save transaction could describe text that
    // was never committed. Asserting the counts move together is the closest a
    // test can get to that without a fault injector.
    const id = await create();
    await save(id, { bodyMarkdown: 'Second version.' });

    const row = await queryOne<RowDataPacket & { body: string; revisions: number }>(
      harness.pool,
      `SELECT ed.body_markdown AS body,
              (SELECT COUNT(*) FROM essay_revision WHERE content_item_id = ed.content_item_id)
                AS revisions
         FROM essay_detail ed WHERE ed.content_item_id = ?`,
      [id],
    );
    expect(row?.body).toBe('Second version.');
    expect(Number(row?.revisions)).toBe(2);
  });

  it('numbers revisions per essay, not globally', async () => {
    const first = await create({ title: 'First Essay' });
    const second = await create({ title: 'Second Essay' });
    await save(second, { title: 'Second Essay', bodyMarkdown: 'Changed.' });

    expect((await listEssayRevisions(harness.pool, first))[0]?.revisionNumber).toBe(1);
    expect((await listEssayRevisions(harness.pool, second))[0]?.revisionNumber).toBe(2);
  });

  it('refuses two revisions with the same number', async () => {
    const id = await create();
    await expect(
      execute(
        harness.pool,
        `INSERT INTO essay_revision
           (content_item_id, revision_number, title, body_markdown, status, word_count)
         VALUES (?, 1, 'Duplicate', 'x', 'draft', 1)`,
        [id],
      ),
    ).rejects.toThrow(/Duplicate/i);
  });

  it('removes the history when the essay is deleted', async () => {
    const id = await create();
    await save(id, { bodyMarkdown: 'Another version.' });

    await execute(harness.pool, 'DELETE FROM content_item WHERE id = ?', [id]);

    const rows = await queryRows<RowDataPacket>(harness.pool, 'SELECT id FROM essay_revision');
    expect(rows).toHaveLength(0);
  });

  // --- Reading -------------------------------------------------------------

  it('finds the revision before a given one', async () => {
    const id = await create();
    await save(id, { bodyMarkdown: 'Second.' });
    await save(id, { bodyMarkdown: 'Third.' });

    const previous = await findPreviousRevision(harness.pool, id, 3);
    expect(previous?.revisionNumber).toBe(2);
    expect(previous?.bodyMarkdown).toBe('Second.');
  });

  it('has nothing before the first revision', async () => {
    const id = await create();
    expect(await findPreviousRevision(harness.pool, id, 1)).toBeNull();
  });

  it('shows the history page with a comparison', async () => {
    const id = await create();
    await save(id, { bodyMarkdown: 'The commission met in August.' });

    const list = await getPage(harness, `/admin/essays/${id}/revisions`, admin);
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('Revision');

    const compare = await getPage(harness, `/admin/essays/${id}/revisions/2`, admin);
    expect(compare.statusCode).toBe(200);
    expect(compare.body).toContain('August');
  });

  it('escapes revision text rather than rendering it', async () => {
    // The comparison prints stored prose. Markdown bodies are written by the
    // operator, but the page must still be markup-safe or the CSP is the only
    // thing left between a stray tag and a broken admin page.
    const id = await create({ bodyMarkdown: 'plain' });
    await save(id, { bodyMarkdown: '<script>alert(1)</script>' });

    const compare = await getPage(harness, `/admin/essays/${id}/revisions/2`, admin);
    expect(compare.body).not.toContain('<script>alert(1)</script>');
    expect(compare.body).toContain('&lt;script&gt;');
  });

  it('404s for a revision that does not exist', async () => {
    const id = await create();
    expect((await getPage(harness, `/admin/essays/${id}/revisions/99`, admin)).statusCode).toBe(
      404,
    );
  });

  it('is not reachable without a session', async () => {
    const id = await create();
    const response = await harness.app.inject({
      method: 'GET',
      url: `/admin/essays/${id}/revisions`,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(300);
    expect(response.body).not.toContain('The commission met');
  });

  // --- Restoring -----------------------------------------------------------

  it('restores an earlier revision as a new revision', async () => {
    const id = await create({ bodyMarkdown: 'The original sentence.' });
    await save(id, { bodyMarkdown: 'A regrettable rewrite.' });

    const page = await getPage(harness, `/admin/essays/${id}/revisions`, admin);
    const result = await postForm(harness, `/admin/essays/${id}/revisions/1/restore`, admin, {
      _csrf: page.csrf,
    });
    expect(result.location).toBe(`/admin/essays/${id}/edit?msg=essay_restored`);

    const essay = await findEssayById(harness.pool, id, adminViewer(harness.userId));
    expect(essay?.bodyMarkdown).toBe('The original sentence.');

    // Three revisions, not two: nothing was rewound.
    const revisions = await listEssayRevisions(harness.pool, id);
    expect(revisions).toHaveLength(3);
    expect(revisions[0]).toMatchObject({ revisionNumber: 3, source: 'restore', restoredFrom: 1 });
  });

  it('keeps the superseded text in the history after a restore', async () => {
    const id = await create({ bodyMarkdown: 'The original sentence.' });
    await save(id, { bodyMarkdown: 'A regrettable rewrite.' });

    const page = await getPage(harness, `/admin/essays/${id}/revisions`, admin);
    await postForm(harness, `/admin/essays/${id}/revisions/1/restore`, admin, {
      _csrf: page.csrf,
    });

    // The rewrite is still recoverable; a restore is not a deletion.
    expect((await findEssayRevision(harness.pool, id, 2))?.bodyMarkdown).toBe(
      'A regrettable rewrite.',
    );
  });

  it('does not republish when restoring a revision saved while public', async () => {
    // Visibility is a decision about now, never a property of old text.
    // Restoring prose written while the essay was public must not re-expose it.
    const id = await create({ visibility: 'public', bodyMarkdown: 'Published text.' });
    await save(id, { visibility: 'public', bodyMarkdown: 'Second published text.' });
    await save(id, { visibility: 'private', bodyMarkdown: 'Withdrawn for revision.' });

    const page = await getPage(harness, `/admin/essays/${id}/revisions`, admin);
    await postForm(harness, `/admin/essays/${id}/revisions/1/restore`, admin, {
      _csrf: page.csrf,
    });

    const essay = await findEssayById(harness.pool, id, adminViewer(harness.userId));
    expect(essay?.bodyMarkdown).toBe('Published text.');
    expect(essay?.visibility).toBe('private');
  });

  it('rebuilds references over the restored prose', async () => {
    // A restore is an ordinary save, so the projections must follow the text
    // back. A mention left behind would list a person the prose no longer names.
    const id = await create({ bodyMarkdown: 'Nothing referenced here.' });
    await save(id, { bodyMarkdown: 'Chaired by [[person:ion-antonescu|Antonescu]].' });

    const afterRewrite = await queryRows<RowDataPacket>(
      harness.pool,
      'SELECT id FROM mention WHERE from_item_id = ?',
      [id],
    );

    const page = await getPage(harness, `/admin/essays/${id}/revisions`, admin);
    await postForm(harness, `/admin/essays/${id}/revisions/1/restore`, admin, {
      _csrf: page.csrf,
    });

    const afterRestore = await queryRows<RowDataPacket>(
      harness.pool,
      'SELECT id FROM mention WHERE from_item_id = ?',
      [id],
    );
    expect(afterRestore.length).toBeLessThan(afterRewrite.length + 1);
    expect(afterRestore).toHaveLength(0);
  });

  it('refuses a restore without a CSRF token', async () => {
    const id = await create({ bodyMarkdown: 'The original sentence.' });
    await save(id, { bodyMarkdown: 'A rewrite.' });

    const result = await postForm(harness, `/admin/essays/${id}/revisions/1/restore`, admin, {});
    expect(result.statusCode).toBe(403);

    const essay = await findEssayById(harness.pool, id, adminViewer(harness.userId));
    expect(essay?.bodyMarkdown).toBe('A rewrite.');
  });

  it('404s when restoring a revision that does not exist', async () => {
    const id = await create();
    const page = await getPage(harness, `/admin/essays/${id}/revisions`, admin);
    const result = await postForm(harness, `/admin/essays/${id}/revisions/42/restore`, admin, {
      _csrf: page.csrf,
    });
    expect(result.statusCode).toBe(404);
  });
});
