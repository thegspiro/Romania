/**
 * Publishing a compiled document for public download.
 *
 * A compiled file is the one object in this application that holds every
 * section at once, so it is the single place a mistake would disclose
 * everything to everybody. Until now the answer was to serve one to nobody but
 * an authenticated administrator. Making one downloadable is therefore not a
 * relaxation of that rule but a replacement of it by two stricter ones, and
 * both are pinned here:
 *
 *   1. **Publishing is a deliberate act with conditions.** Compiling makes
 *      nothing downloadable; an administrator publishes one build, and the
 *      build must have been assembled for the public, have finished, have
 *      produced bytes, have a record of what went into it, and contain nothing
 *      that is no longer published.
 *   2. **The bytes are re-checked on every request.** A file was written once
 *      and cannot know that a chapter was withdrawn afterwards, so the question
 *      is asked again at each download and the answer is 404 -- never 403,
 *      which would confirm the manuscript exists at that slug.
 *
 * Requires MySQL. Without one the suite skips rather than fails; check the
 * output before believing a green run covered this.
 */
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import {
  cookieHeader,
  createHarness,
  csrfFrom,
  databaseAvailable,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { makeEssay, makeManuscript } from './fixtures.js';
import { execute, queryOne, queryRows } from '../../src/db/pool.js';
import { addSection, deleteManuscript, findManuscriptById } from '../../src/content/manuscripts.js';
import {
  findBuild,
  findPublicDownload,
  publishBuild,
  requestBuild,
  withdrawBuild,
  type BuildAudience,
  type BuildFormat,
} from '../../src/content/builds.js';
import { setEssayVisibility, deleteEssay } from '../../src/content/essays.js';
import { insertFileObject } from '../../src/files/repository.js';
import { storeBuffer } from '../../src/files/storage.js';
import { adminViewer, type Visibility } from '../../src/content/visibility.js';

const STORAGE_ROOT = '/tmp/dissertation-published-download-test-files';
const available = await databaseAvailable();

describe.skipIf(!available)('published downloads', () => {
  let harness: Harness;
  let admin: ReturnType<typeof adminViewer>;

  beforeAll(async () => {
    harness = await createHarness({ STORAGE_ROOT });
    admin = adminViewer(harness.userId);
  });

  afterAll(async () => {
    await harness.close();
    await rm(STORAGE_ROOT, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
  });

  /** A published manuscript of two published chapters. */
  async function manuscript(visibility: Visibility = 'public'): Promise<{
    id: number;
    slug: string;
    chapters: number[];
  }> {
    const id = await makeManuscript(harness.pool, 'A Dissertation', visibility);
    const first = await makeEssay(
      harness.pool,
      'Opening Chapter',
      'public',
      '# Opening\n\nThe first chapter.',
    );
    const last = await makeEssay(
      harness.pool,
      'Closing Chapter',
      'public',
      '# Closing\n\nThe last chapter.',
    );
    for (const chapter of [first.id, last.id]) {
      const outcome = await addSection(harness.pool, id, chapter, { depth: 0, role: 'body' });
      expect(outcome.ok).toBe(true);
    }
    const record = await findManuscriptById(harness.pool, id, admin);
    expect(record).not.toBeNull();
    return { id, slug: record!.slug, chapters: [first.id, last.id] };
  }

  /**
   * Compiles a build and pretends the worker finished it.
   *
   * The bytes name a chapter, so a leak shows up as content rather than only
   * as a status code.
   */
  async function compiled(
    manuscriptId: number,
    options: { audience?: BuildAudience; format?: BuildFormat; finish?: boolean } = {},
  ): Promise<number> {
    const record = await findManuscriptById(harness.pool, manuscriptId, admin);
    const build = await requestBuild(harness.pool, harness.config, harness.storage, record!, {
      format: options.format ?? 'html',
      audience: options.audience ?? 'public',
      requestedBy: harness.userId,
    });

    if (options.finish === false) return build.buildId;

    const stored = await storeBuffer(
      harness.storage,
      Buffer.from('<h1>Opening</h1><h1>Closing</h1>'),
    );
    const fileObjectId = await insertFileObject(harness.pool, {
      sha256: stored.sha256,
      byteSize: stored.byteSize,
      mimeType: 'text/html',
      originalFilename: 'document.html',
      storageKey: stored.storageKey,
    });
    await execute(
      harness.pool,
      `UPDATE manuscript_build SET state = 'succeeded', file_object_id = ? WHERE id = ?`,
      [fileObjectId, build.buildId],
    );
    return build.buildId;
  }

  describe('what went into the document', () => {
    it('records every assembled section, and only those', async () => {
      const { id, chapters } = await manuscript();
      const buildId = await compiled(id);

      const rows = await queryRows<RowDataPacket & { content_item_id: number }>(
        harness.pool,
        'SELECT content_item_id FROM manuscript_build_item WHERE build_id = ? ORDER BY content_item_id',
        [buildId],
      );
      expect(rows.map((row) => Number(row.content_item_id))).toEqual(
        [...chapters].sort((a, b) => a - b),
      );
    });

    it('records only what the audience could see', async () => {
      const { id } = await manuscript();
      const hidden = await makeEssay(harness.pool, 'Withheld Chapter', 'private', '# Withheld');
      await addSection(harness.pool, id, hidden.id, { depth: 0, role: 'body' });

      const publicBuild = await compiled(id, { audience: 'public' });
      const adminBuild = await compiled(id, { audience: 'admin' });

      const build = await findBuild(harness.pool, publicBuild);
      expect(build?.itemCount).toBe(2);
      expect((await findBuild(harness.pool, adminBuild))?.itemCount).toBe(3);
    });

    it('survives the deletion of a chapter, so the record cannot shrink', async () => {
      // Deliberately no foreign key: a cascade would delete the row and leave
      // a build that looks like it contains less and is therefore *more*
      // servable. The row stands, and the re-check fails on it instead.
      const { id, chapters } = await manuscript();
      const buildId = await compiled(id);

      expect(await deleteEssay(harness.pool, chapters[0]!)).toBe('deleted');

      const build = await findBuild(harness.pool, buildId);
      expect(build?.itemCount).toBe(2);
    });
  });

  describe('publishing', () => {
    it('refuses a build that has not finished', async () => {
      const { id } = await manuscript();
      const buildId = await compiled(id, { finish: false });

      expect(await publishBuild(harness.pool, buildId, harness.userId)).toEqual({
        ok: false,
        reason: 'not_succeeded',
      });
    });

    it('refuses a build that produced no file', async () => {
      const { id } = await manuscript();
      const buildId = await compiled(id, { finish: false });
      await execute(harness.pool, `UPDATE manuscript_build SET state = 'succeeded' WHERE id = ?`, [
        buildId,
      ]);

      expect(await publishBuild(harness.pool, buildId, harness.userId)).toEqual({
        ok: false,
        reason: 'no_output',
      });
    });

    it('refuses an administrator build, whatever else is true of it', async () => {
      // The one that matters most: this document was assembled with an admin
      // viewer, so it contains the private material in full.
      const { id } = await manuscript();
      const buildId = await compiled(id, { audience: 'admin' });

      expect(await publishBuild(harness.pool, buildId, harness.userId)).toEqual({
        ok: false,
        reason: 'not_public_audience',
      });
    });

    it('refuses while the manuscript itself is unpublished', async () => {
      const { id } = await manuscript('private');
      const buildId = await compiled(id);

      expect(await publishBuild(harness.pool, buildId, harness.userId)).toEqual({
        ok: false,
        reason: 'manuscript_not_public',
      });
    });

    it('refuses a build compiled before this application recorded its contents', async () => {
      // How a document compiled before the withholding fix is kept out of
      // public reach without a version flag to remember: it has no recorded
      // items, so nothing about it can be re-checked.
      const { id } = await manuscript();
      const buildId = await compiled(id);
      await execute(harness.pool, 'DELETE FROM manuscript_build_item WHERE build_id = ?', [
        buildId,
      ]);

      expect(await publishBuild(harness.pool, buildId, harness.userId)).toEqual({
        ok: false,
        reason: 'no_recorded_items',
      });
    });

    it('refuses once a chapter it contains has been unpublished', async () => {
      const { id, chapters } = await manuscript();
      const buildId = await compiled(id);
      await setEssayVisibility(harness.pool, chapters[0]!, 'private');

      expect(await publishBuild(harness.pool, buildId, harness.userId)).toEqual({
        ok: false,
        reason: 'contains_unpublished',
      });
    });

    it('publishes a clean build and records who did it', async () => {
      const { id } = await manuscript();
      const buildId = await compiled(id);

      expect(await publishBuild(harness.pool, buildId, harness.userId)).toEqual({ ok: true });

      const build = await findBuild(harness.pool, buildId);
      expect(build?.publishedAt).not.toBeNull();
      expect(build?.publishedBy).toBe(harness.userId);
    });

    it('leaves at most one published build per manuscript', async () => {
      const { id } = await manuscript();
      const first = await compiled(id);
      const second = await compiled(id);

      expect(await publishBuild(harness.pool, first, harness.userId)).toEqual({ ok: true });
      expect(await publishBuild(harness.pool, second, harness.userId)).toEqual({ ok: true });

      expect((await findBuild(harness.pool, first))?.publishedAt).toBeNull();
      expect((await findBuild(harness.pool, second))?.publishedAt).not.toBeNull();

      // Not an application rule that could be forgotten: the publication table
      // is keyed on the manuscript, so a second published build has nowhere to
      // go.
      const row = await queryOne<RowDataPacket & { total: number }>(
        harness.pool,
        'SELECT COUNT(*) AS total FROM manuscript_published_build WHERE manuscript_item_id = ?',
        [id],
      );
      expect(Number(row?.total)).toBe(1);
    });

    it('takes the publication with the manuscript when it is deleted', async () => {
      // The row is reachable by two cascade paths at once -- from the
      // manuscript's content_item and from the build -- and both fire on this
      // delete. Pinned because a schema that errors here would make a
      // published manuscript undeletable.
      const { id } = await manuscript();
      const buildId = await compiled(id);
      await publishBuild(harness.pool, buildId, harness.userId);

      expect(await deleteManuscript(harness.pool, id)).toBe(true);

      const row = await queryOne<RowDataPacket & { total: number }>(
        harness.pool,
        'SELECT COUNT(*) AS total FROM manuscript_published_build',
        [],
      );
      expect(Number(row?.total)).toBe(0);
    });

    it('withdraws a published build', async () => {
      const { id, slug } = await manuscript();
      const buildId = await compiled(id);
      await publishBuild(harness.pool, buildId, harness.userId);

      expect(await withdrawBuild(harness.pool, buildId)).toBe(true);
      expect(await findPublicDownload(harness.pool, slug)).toBeNull();
      // Nothing left to withdraw the second time.
      expect(await withdrawBuild(harness.pool, buildId)).toBe(false);
    });
  });

  describe('the download route', () => {
    async function get(slug: string, cookie?: string) {
      return harness.app.inject({
        method: 'GET',
        url: `/manuscripts/${slug}/download`,
        ...(cookie === undefined ? {} : { headers: { cookie } }),
      });
    }

    it('404s a manuscript with nothing published', async () => {
      const { slug } = await manuscript();
      const response = await get(slug);
      expect(response.statusCode).toBe(404);
    });

    it('serves a published build as an attachment', async () => {
      const { id, slug } = await manuscript();
      const buildId = await compiled(id);
      await publishBuild(harness.pool, buildId, harness.userId);

      const response = await get(slug);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toBe(`attachment; filename="${slug}.html"`);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).toContain('Opening');
    });

    it('stops serving the moment a chapter inside it is unpublished', async () => {
      // The property the whole design exists for: the bytes were written once
      // and cannot know. So the question is asked again, now.
      const { id, slug, chapters } = await manuscript();
      const buildId = await compiled(id);
      await publishBuild(harness.pool, buildId, harness.userId);
      expect((await get(slug)).statusCode).toBe(200);

      await setEssayVisibility(harness.pool, chapters[1]!, 'private');

      const response = await get(slug);
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('Closing');

      // And to an administrator too: the route answers about the public
      // document, not about who is asking.
      const jar = await signIn(harness);
      expect((await get(slug, cookieHeader(jar))).statusCode).toBe(404);
    });

    it('stops serving when a chapter inside it is deleted', async () => {
      const { id, slug, chapters } = await manuscript();
      const buildId = await compiled(id);
      await publishBuild(harness.pool, buildId, harness.userId);

      expect(await deleteEssay(harness.pool, chapters[0]!)).toBe('deleted');
      expect((await get(slug)).statusCode).toBe(404);
    });

    it('stops serving when the manuscript itself is unpublished', async () => {
      const { id, slug } = await manuscript();
      const buildId = await compiled(id);
      await publishBuild(harness.pool, buildId, harness.userId);

      // Exactly what the application does: a plain UPDATE that revisits
      // nothing derived from it.
      await execute(harness.pool, `UPDATE content_item SET visibility = 'private' WHERE id = ?`, [
        id,
      ]);

      expect((await get(slug)).statusCode).toBe(404);
    });

    it('404s rather than 403s, and says nothing about what exists', async () => {
      const { id, slug } = await manuscript('private');
      await compiled(id);

      const response = await get(slug);
      expect(response.statusCode).toBe(404);
      expect(response.statusCode).not.toBe(403);
      expect(response.body).not.toContain('A Dissertation');

      const unknown = await get('no-such-manuscript');
      expect(unknown.statusCode).toBe(404);
    });

    it('never reaches the compiled bytes through the file route', async () => {
      const { id, slug } = await manuscript();
      const buildId = await compiled(id);
      await publishBuild(harness.pool, buildId, harness.userId);

      const build = await findBuild(harness.pool, buildId);
      const response = await harness.app.inject({
        method: 'GET',
        url: `/files/${build!.fileObjectId}/original`,
      });
      // No artifact or source owns a compiled build, so that route 404s for
      // one. Publishing a download must not have changed that.
      expect(response.statusCode).toBe(404);
      expect((await get(slug)).statusCode).toBe(200);
    });
  });

  describe('the pages', () => {
    it('offers the download on the manuscript page only once it is published', async () => {
      const { id, slug } = await manuscript();
      const buildId = await compiled(id);

      const before = await harness.app.inject({ method: 'GET', url: `/manuscripts/${slug}` });
      expect(before.body).not.toContain(`/manuscripts/${slug}/download`);

      await publishBuild(harness.pool, buildId, harness.userId);

      const after = await harness.app.inject({ method: 'GET', url: `/manuscripts/${slug}` });
      expect(after.body).toContain(`/manuscripts/${slug}/download`);
    });

    it('publishes and withdraws through the admin form, and audits both', async () => {
      const { id, slug } = await manuscript();
      const buildId = await compiled(id);

      const jar = await signIn(harness);
      const outline = await harness.app.inject({
        method: 'GET',
        url: `/admin/manuscripts/${id}/outline`,
        headers: { cookie: cookieHeader(jar) },
      });
      const csrf = csrfFrom(outline.body);

      const publish = await harness.app.inject({
        method: 'POST',
        url: `/admin/manuscripts/${id}/builds/${buildId}/publish`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(publish.statusCode).toBe(302);
      expect(publish.headers.location).toBe(`/admin/manuscripts/${id}/outline?msg=build_published`);
      expect((await get(slug)).statusCode).toBe(200);

      const withdraw = await harness.app.inject({
        method: 'POST',
        url: `/admin/manuscripts/${id}/builds/${buildId}/withdraw`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(csrf)}`,
      });
      expect(withdraw.statusCode).toBe(302);
      expect((await get(slug)).statusCode).toBe(404);

      const actions = await queryRows<RowDataPacket & { action: string }>(
        harness.pool,
        `SELECT action FROM audit_log WHERE action LIKE 'build.%' ORDER BY id`,
        [],
      );
      expect(actions.map((row) => row.action)).toEqual(['build.publish', 'build.withdraw']);
    });

    it('reports the reason a build cannot be published', async () => {
      const { id } = await manuscript();
      const buildId = await compiled(id, { audience: 'admin' });

      const jar = await signIn(harness);
      const response = await harness.app.inject({
        method: 'POST',
        url: `/admin/manuscripts/${id}/builds/${buildId}/publish`,
        headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${encodeURIComponent(
          csrfFrom(
            (
              await harness.app.inject({
                method: 'GET',
                url: `/admin/manuscripts/${id}/outline`,
                headers: { cookie: cookieHeader(jar) },
              })
            ).body,
          ),
        )}`,
      });
      expect(response.headers.location).toBe(
        `/admin/manuscripts/${id}/outline?msg=build_not_public_audience`,
      );
    });

    it('needs an authenticated administrator to publish at all', async () => {
      const { id, slug } = await manuscript();
      const buildId = await compiled(id);

      const response = await harness.app.inject({
        method: 'POST',
        url: `/admin/manuscripts/${id}/builds/${buildId}/publish`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '_csrf=nonsense',
      });
      expect(response.statusCode).not.toBe(200);

      // Nothing was published, so the public route still has nothing to serve.
      expect((await findBuild(harness.pool, buildId))?.publishedAt).toBeNull();
      expect((await get(slug)).statusCode).toBe(404);
    });

    async function get(slug: string, cookie?: string) {
      return harness.app.inject({
        method: 'GET',
        url: `/manuscripts/${slug}/download`,
        ...(cookie === undefined ? {} : { headers: { cookie } }),
      });
    }
  });
});
