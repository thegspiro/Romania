/**
 * The public/private rule.
 *
 * This is the suite that matters most. The whole application exists to hold
 * unpublished research about named people, and the single failure that would
 * make it unusable is material becoming readable before the operator chose to
 * publish it. Each test below pins one of the invariants documented in
 * src/content/visibility.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { listSources, findSourceBySlug } from '../../src/content/sources.js';
import { ANONYMOUS, adminViewer, visibilityFilter } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('visibility', () => {
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

  async function createSource(fields: Record<string, string>): Promise<number> {
    const page = await getPage(harness, '/admin/sources/new', admin);
    const result = await postForm(harness, '/admin/sources', admin, {
      ...sourceForm(fields),
      _csrf: page.csrf,
    });
    const id = /\/admin\/sources\/(\d+)\/edit/.exec(result.location ?? '')?.[1];
    if (id === undefined) throw new Error(`create failed: ${result.statusCode} ${result.body}`);
    return Number(id);
  }

  it('returns 404, not 403, for a private item', async () => {
    // A 403 confirms the item exists at that slug, and for unpublished
    // research about a named person that confirmation is the disclosure.
    await createSource({ title: 'Secret Report', visibility: 'private' });

    const response = await harness.app.inject({ method: 'GET', url: '/sources/secret-report' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Secret Report');
  });

  it('serves a public item to an anonymous visitor', async () => {
    await createSource({ title: 'Published Work', visibility: 'public' });

    const response = await harness.app.inject({ method: 'GET', url: '/sources/published-work' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Published Work');
  });

  it('keeps private items out of the anonymous index entirely', async () => {
    await createSource({ title: 'Secret Report', visibility: 'private' });
    await createSource({ title: 'Published Work', visibility: 'public' });

    const response = await harness.app.inject({ method: 'GET', url: '/sources' });
    expect(response.body).toContain('Published Work');
    expect(response.body).not.toContain('Secret Report');
    // Not even the slug or id may leak.
    expect(response.body).not.toContain('secret-report');
  });

  it('shows private items to the administrator on the public side, marked as such', async () => {
    await createSource({ title: 'Secret Report', visibility: 'private' });

    const page = await getPage(harness, '/sources', admin);
    expect(page.body).toContain('Secret Report');
    expect(page.body).toContain('badge-private');
  });

  it('does not honour a visibility filter from an anonymous query string', async () => {
    // Passing ?visibility=private must not become a way to enumerate them.
    await createSource({ title: 'Secret Report', visibility: 'private' });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/sources?visibility=private',
    });
    expect(response.body).not.toContain('Secret Report');
  });

  it('applies the filter in the repository, not only in the route', async () => {
    await createSource({ title: 'Secret Report', visibility: 'private' });
    await createSource({ title: 'Published Work', visibility: 'public' });

    const anonymous = await listSources(harness.pool, ANONYMOUS);
    expect(anonymous.total).toBe(1);
    expect(anonymous.items[0]?.title).toBe('Published Work');

    const asAdmin = await listSources(harness.pool, adminViewer(harness.userId));
    expect(asAdmin.total).toBe(2);

    expect(await findSourceBySlug(harness.pool, 'secret-report', ANONYMOUS)).toBeNull();
    expect(
      await findSourceBySlug(harness.pool, 'secret-report', adminViewer(harness.userId)),
    ).not.toBeNull();
  });

  it('sends noindex headers for a public page while indexing is disabled', async () => {
    await createSource({ title: 'Published Work', visibility: 'public' });

    const response = await harness.app.inject({ method: 'GET', url: '/sources/published-work' });
    expect(response.headers['x-robots-tag']).toContain('noindex');
  });

  it('disallows everything in robots.txt while indexing is disabled', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/robots.txt' });
    expect(response.body).toContain('Disallow: /');
  });

  it('unpublishing makes a page unreachable again', async () => {
    const id = await createSource({ title: 'Published Work', visibility: 'public' });
    expect((await harness.app.inject({ url: '/sources/published-work' })).statusCode).toBe(200);

    const listing = await getPage(harness, '/admin/sources', admin);
    await postForm(harness, `/admin/sources/${id}/visibility`, admin, {
      _csrf: listing.csrf,
      visibility: 'private',
    });

    expect((await harness.app.inject({ url: '/sources/published-work' })).statusCode).toBe(404);
  });
});

describe('visibilityFilter', () => {
  it('never returns an empty predicate', () => {
    // Callers always AND it in; an empty string would produce SQL that is
    // syntactically valid and silently leaks.
    expect(visibilityFilter(ANONYMOUS, 'ci').sql).not.toBe('');
    expect(visibilityFilter(adminViewer(1), 'ci').sql).not.toBe('');
  });

  it('restricts anonymous viewers to public rows', () => {
    expect(visibilityFilter(ANONYMOUS, 'ci').sql).toBe("ci.visibility = 'public'");
  });

  it('rejects an unsafe table alias', () => {
    // The alias is written into SQL, so it is the one value that must be
    // constrained by shape rather than binding.
    expect(() => visibilityFilter(ANONYMOUS, 'ci; DROP TABLE content_item; --')).toThrow(TypeError);
    expect(() => visibilityFilter(ANONYMOUS, '1=1 OR ')).toThrow(TypeError);
  });
});
