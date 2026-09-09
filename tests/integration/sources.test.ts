/**
 * The Sources vertical slice, end to end through HTTP and MySQL.
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
import { execute, queryOne } from '../../src/db/pool.js';
import { findSourceById, listSources } from '../../src/content/sources.js';
import { adminViewer } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('sources', () => {
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

  async function create(fields: Record<string, string> = {}): Promise<number> {
    const page = await getPage(harness, '/admin/sources/new', admin);
    const result = await postForm(harness, '/admin/sources', admin, {
      ...sourceForm(fields),
      _csrf: page.csrf,
    });
    const id = /\/admin\/sources\/(\d+)\/edit/.exec(result.location ?? '')?.[1];
    if (id === undefined) throw new Error(`create failed: ${result.statusCode}`);
    return Number(id);
  }

  it('creates a source and stores it as CSL-JSON', async () => {
    const id = await create({
      title: 'The Hooligan Year',
      cslType: 'book',
      authors: 'Ionescu, Maria',
      publisher: 'Humanitas',
      issued: '1998',
    });

    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    expect(source?.csl.type).toBe('book');
    expect(source?.csl.author).toEqual([{ family: 'Ionescu', given: 'Maria' }]);
    expect(source?.issuedYear).toBe(1998);
  });

  it('derives the scalar columns from the CSL record', async () => {
    // They exist so listings need not open the JSON; they must be written on
    // every save or sorting and filtering silently go stale.
    const id = await create({
      title: 'Journal Piece',
      cslType: 'article-journal',
      containerTitle: 'Slavic Review',
      issued: '2001',
    });

    const row = await queryOne<RowDataPacket & { container_title: string; issued_year: number }>(
      harness.pool,
      'SELECT container_title, issued_year FROM source_detail WHERE content_item_id = ?',
      [id],
    );
    expect(row?.container_title).toBe('Slavic Review');
    expect(row?.issued_year).toBe(2001);
  });

  it('generates a slug from a title with Romanian diacritics', async () => {
    await create({ title: 'Raport asupra Comisiei de la Iași' });
    const row = await queryOne<RowDataPacket & { slug: string }>(
      harness.pool,
      "SELECT slug FROM content_item WHERE kind = 'source' ORDER BY id DESC LIMIT 1",
    );
    expect(row?.slug).toBe('raport-asupra-comisiei-de-la-iasi');
  });

  it('disambiguates a repeated title', async () => {
    await create({ title: 'Same Title' });
    await create({ title: 'Same Title' });

    const rows = await listSources(harness.pool, adminViewer(harness.userId));
    const slugs = rows.items.map((item) => item.slug).sort();
    expect(slugs).toEqual(['same-title', 'same-title-2']);
  });

  it('rejects a source with no title', async () => {
    const page = await getPage(harness, '/admin/sources/new', admin);
    const result = await postForm(harness, '/admin/sources', admin, {
      ...sourceForm({ title: '' }),
      _csrf: page.csrf,
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('A title is required');
  });

  it('rejects an invented source type', async () => {
    const page = await getPage(harness, '/admin/sources/new', admin);
    const result = await postForm(harness, '/admin/sources', admin, {
      ...sourceForm({ cslType: 'not-a-real-type' }),
      _csrf: page.csrf,
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('Choose a source type');
  });

  it('keeps the slug stable when the title is edited', async () => {
    // Public source pages are meant to be cited by URL; fixing a typo in a
    // title must not break every citation that points at it.
    const id = await create({ title: 'Original Title' });
    const editPage = await getPage(harness, `/admin/sources/${id}/edit`, admin);

    await postForm(harness, `/admin/sources/${id}`, admin, {
      ...sourceForm({ title: 'Corrected Title' }),
      _csrf: editPage.csrf,
    });

    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    expect(source?.title).toBe('Corrected Title');
    expect(source?.slug).toBe('original-title');
    // The CSL id follows the slug, so citations keep resolving.
    expect(source?.csl.id).toBe('original-title');
  });

  it('records published_at the first time an item becomes public', async () => {
    const id = await create({ title: 'To Publish', visibility: 'private' });
    const listing = await getPage(harness, '/admin/sources', admin);

    await postForm(harness, `/admin/sources/${id}/visibility`, admin, {
      _csrf: listing.csrf,
      visibility: 'public',
    });
    const first = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    expect(first?.publishedAt).not.toBeNull();

    // Unpublishing keeps the original date for the audit trail.
    await postForm(harness, `/admin/sources/${id}/visibility`, admin, {
      _csrf: listing.csrf,
      visibility: 'private',
    });
    const second = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    expect(second?.publishedAt?.getTime()).toBe(first?.publishedAt?.getTime());
  });

  it('searches accent-insensitively', async () => {
    await create({ title: 'Raport asupra Comisiei de la Iași' });
    const withoutDiacritics = await listSources(harness.pool, adminViewer(harness.userId), {
      search: 'Iasi',
    });
    expect(withoutDiacritics.total).toBe(1);
  });

  it('escapes LIKE wildcards in a search term', async () => {
    // Without escaping, searching for "%" matches every row.
    await create({ title: 'Ordinary Title' });
    const result = await listSources(harness.pool, adminViewer(harness.userId), { search: '%' });
    expect(result.total).toBe(0);
  });

  it('searches archival fields as well as the title', async () => {
    await create({
      title: 'Archival Item',
      archive: 'Arhivele Naționale',
      callNumber: 'ANR-12-45',
    });
    expect(
      (await listSources(harness.pool, adminViewer(harness.userId), { search: 'ANR-12' })).total,
    ).toBe(1);
    expect(
      (await listSources(harness.pool, adminViewer(harness.userId), { search: 'Arhivele' })).total,
    ).toBe(1);
  });

  it('deletes a source that nothing cites', async () => {
    const id = await create({ title: 'Disposable' });
    const editPage = await getPage(harness, `/admin/sources/${id}/edit`, admin);

    const result = await postForm(harness, `/admin/sources/${id}/delete`, admin, {
      _csrf: editPage.csrf,
    });
    expect(result.location).toContain('msg=source_deleted');
    expect(await findSourceById(harness.pool, id, adminViewer(harness.userId))).toBeNull();
  });

  it('refuses to delete a source that is still cited', async () => {
    // The RESTRICT foreign key exists so removing a source cannot silently
    // break the apparatus of an essay that quotes it.
    const sourceId = await create({ title: 'Cited Source' });
    const essayResult = await execute(
      harness.pool,
      `INSERT INTO content_item (kind, slug, title, visibility)
       VALUES ('essay', 'an-essay', 'An Essay', 'private')`,
    );
    await execute(
      harness.pool,
      'INSERT INTO citation (citing_item_id, source_item_id) VALUES (?, ?)',
      [essayResult.insertId, sourceId],
    );

    const editPage = await getPage(harness, `/admin/sources/${sourceId}/edit`, admin);
    const result = await postForm(harness, `/admin/sources/${sourceId}/delete`, admin, {
      _csrf: editPage.csrf,
    });

    expect(result.location).toContain('msg=source_cited');
    expect(
      await findSourceById(harness.pool, sourceId, adminViewer(harness.userId)),
    ).not.toBeNull();
  });

  it('shows only citing items the viewer may see', async () => {
    const sourceId = await create({ title: 'Public Source', visibility: 'public' });
    const privateEssay = await execute(
      harness.pool,
      `INSERT INTO content_item (kind, slug, title, visibility)
       VALUES ('essay', 'private-essay', 'Private Essay', 'private')`,
    );
    await execute(
      harness.pool,
      'INSERT INTO citation (citing_item_id, source_item_id) VALUES (?, ?)',
      [privateEssay.insertId, sourceId],
    );

    const anonymous = await harness.app.inject({ method: 'GET', url: '/sources/public-source' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.body).not.toContain('Private Essay');

    const asAdmin = await getPage(harness, '/sources/public-source', admin);
    expect(asAdmin.body).toContain('Private Essay');
  });

  it('renders Chicago output on the public page', async () => {
    await create({
      title: 'The Hooligan Year',
      cslType: 'book',
      authors: 'Ionescu, Maria',
      publisher: 'Humanitas',
      issued: '1998',
      visibility: 'public',
    });

    const response = await harness.app.inject({ method: 'GET', url: '/sources/the-hooligan-year' });
    expect(response.body).toContain('Ionescu, Maria. <i>The Hooligan Year</i>. Humanitas, 1998.');
    expect(response.body).toContain('Maria Ionescu, <i>The Hooligan Year</i> (Humanitas, 1998).');
  });

  it('escapes a hostile title in the rendered page', async () => {
    await create({ title: '<script>alert(1)</script>', visibility: 'public' });
    const listing = await harness.app.inject({ method: 'GET', url: '/sources' });
    expect(listing.body).not.toContain('<script>alert(1)</script>');
  });

  it('returns 404 for a malformed slug rather than reaching the database', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: "/sources/' OR 1=1 --",
    });
    expect(response.statusCode).toBe(404);
  });

  it('writes an audit entry for a publish', async () => {
    const id = await create({ title: 'Auditable' });
    const listing = await getPage(harness, '/admin/sources', admin);
    await postForm(harness, `/admin/sources/${id}/visibility`, admin, {
      _csrf: listing.csrf,
      visibility: 'public',
    });

    const entry = await queryOne<RowDataPacket & { action: string; item_id: number }>(
      harness.pool,
      "SELECT action, item_id FROM audit_log WHERE action = 'source.publish' LIMIT 1",
    );
    expect(entry?.item_id).toBe(id);
  });
});
