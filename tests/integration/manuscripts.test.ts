/**
 * The manuscript: pieces of a whole, and the whole recompiled.
 *
 * Three properties are pinned here, and the first two are the ones that would
 * be expensive to get wrong:
 *
 *  1. A public table of contents omits private sections entirely -- no gap, no
 *     placeholder, nothing that betrays a section exists.
 *  2. A compiled document is one object holding many sections, so it is the
 *     single place one visibility mistake would leak everything at once. A
 *     public-audience build must contain only what an anonymous reader could
 *     already read one page at a time.
 *  3. File bytes are re-checked against the owning item on every request.
 *
 * Requires MySQL. Without one the suite skips rather than fails; check the
 * output before believing a green run covered this.
 */
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createHarness,
  databaseAvailable,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { makeEntity, makeEssay, makeManuscript, makeSource } from './fixtures.js';
import type { RowDataPacket } from 'mysql2/promise';
import { execute, queryRows } from '../../src/db/pool.js';
import {
  addSection,
  assembleDocument,
  findManuscriptById,
  listPlacementsOf,
  listSections,
  moveSection,
  navigationFor,
  updateSection,
} from '../../src/content/manuscripts.js';
import { requestBuild, stagingKey } from '../../src/content/builds.js';
import { insertFileObject } from '../../src/files/repository.js';
import { createArtifact, attachFile } from '../../src/content/artifacts.js';
import { resolveStoragePath, storeBuffer } from '../../src/files/storage.js';
import { ANONYMOUS, adminViewer } from '../../src/content/visibility.js';

const STORAGE_ROOT = '/tmp/dissertation-manuscript-test-files';

const available = await databaseAvailable();

describe.skipIf(!available)('manuscripts', () => {
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

  /** A manuscript of three essays, the middle one private, at mixed depths. */
  async function mixedManuscript(): Promise<{
    manuscriptId: number;
    publicIds: number[];
    privateId: number;
  }> {
    const manuscriptId = await makeManuscript(harness.pool, 'A Dissertation', 'public');

    const first = await makeEssay(
      harness.pool,
      'Opening Chapter',
      'public',
      '# Opening\n\nThe first chapter.',
    );
    const hidden = await makeEssay(
      harness.pool,
      'Unpublished Chapter',
      'private',
      '# Withheld\n\nA confidential finding.',
    );
    const last = await makeEssay(
      harness.pool,
      'Conclusion',
      'public',
      '# Closing\n\nThe last chapter.',
    );

    for (const [item, depth] of [
      [first.id, 0],
      [hidden.id, 1],
      [last.id, 0],
    ] as const) {
      const outcome = await addSection(harness.pool, manuscriptId, item, { depth, role: 'body' });
      expect(outcome.ok).toBe(true);
    }

    return { manuscriptId, publicIds: [first.id, last.id], privateId: hidden.id };
  }

  describe('outline', () => {
    it('omits a private section from a public table of contents, with no gap', async () => {
      const { manuscriptId, publicIds, privateId } = await mixedManuscript();

      const anonymous = await listSections(harness.pool, manuscriptId, ANONYMOUS);
      expect(anonymous.map((section) => section.itemId)).toEqual(publicIds);

      // Nothing about the hidden section survives into the public outline.
      const serialised = JSON.stringify(anonymous);
      expect(serialised).not.toContain('Unpublished');
      expect(serialised).not.toContain('unpublished-chapter');
      expect(anonymous.map((section) => section.itemId)).not.toContain(privateId);

      const asAdmin = await listSections(harness.pool, manuscriptId, admin);
      expect(asAdmin).toHaveLength(3);
    });

    it('renders the public contents list with no gap where a section was removed', async () => {
      // The list is numbered by the browser over the filtered rows, so a
      // reader counts 1, 2 -- never 1, 3, which would betray the omission.
      const { manuscriptId } = await mixedManuscript();
      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;

      const page = await harness.app.inject({
        method: 'GET',
        url: `/manuscripts/${manuscript.slug}`,
      });

      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('Unpublished');
      expect(page.body).not.toContain('unpublished-chapter');
      expect(page.body).not.toContain('withheld');
      expect(page.body).toContain('2 sections');

      // The raw ordering column is never rendered, so the gap in it is not
      // visible either.
      const contents = /<ol class="contents">([\s\S]*?)<\/ol>/.exec(page.body)?.[1] ?? '';
      expect(contents.match(/<li/g)).toHaveLength(2);
    });

    it('numbers navigation over the filtered outline, so no reader sees a skipped step', async () => {
      const { manuscriptId, publicIds } = await mixedManuscript();

      // Anonymously: two sections, and the first's "next" is the third piece,
      // presented as the second of two rather than as second of three.
      const first = await navigationFor(harness.pool, manuscriptId, publicIds[0]!, ANONYMOUS);
      expect(first?.total).toBe(2);
      expect(first?.index).toBe(0);
      expect(first?.next?.itemId).toBe(publicIds[1]);
      expect(first?.previous).toBeNull();

      const last = await navigationFor(harness.pool, manuscriptId, publicIds[1]!, ANONYMOUS);
      expect(last?.index).toBe(1);
      expect(last?.next).toBeNull();

      const asAdmin = await navigationFor(harness.pool, manuscriptId, publicIds[0]!, admin);
      expect(asAdmin?.total).toBe(3);
    });

    it('does not resolve navigation into a private section for an anonymous reader', async () => {
      const { manuscriptId, privateId } = await mixedManuscript();
      expect(await navigationFor(harness.pool, manuscriptId, privateId, ANONYMOUS)).toBeNull();
      expect(await navigationFor(harness.pool, manuscriptId, privateId, admin)).not.toBeNull();
    });

    it('hides a private manuscript from an anonymous reader entirely', async () => {
      const manuscriptId = await makeManuscript(harness.pool, 'Draft Thesis', 'private');
      const essay = await makeEssay(harness.pool, 'A Chapter', 'public', 'Body.');
      await addSection(harness.pool, manuscriptId, essay.id);

      expect(await findManuscriptById(harness.pool, manuscriptId, ANONYMOUS)).toBeNull();
      expect(await navigationFor(harness.pool, manuscriptId, essay.id, ANONYMOUS)).toBeNull();

      // And the public essay must not advertise the private manuscript it is in.
      expect(await listPlacementsOf(harness.pool, essay.id, ANONYMOUS)).toEqual([]);
      expect(await listPlacementsOf(harness.pool, essay.id, admin)).toHaveLength(1);
    });

    it('lets one essay serve as a chapter in two manuscripts but not twice in one', async () => {
      // This is what makes a chapter reusable as a journal article.
      const thesis = await makeManuscript(harness.pool, 'The Thesis', 'private');
      const article = await makeManuscript(harness.pool, 'A Journal Article', 'private');
      const essay = await makeEssay(harness.pool, 'Shared Chapter', 'public', 'Body.');

      expect((await addSection(harness.pool, thesis, essay.id)).ok).toBe(true);
      expect((await addSection(harness.pool, article, essay.id)).ok).toBe(true);

      const repeat = await addSection(harness.pool, thesis, essay.id);
      expect(repeat).toEqual({ ok: false, reason: 'already_present' });

      expect(await listPlacementsOf(harness.pool, essay.id, admin)).toHaveLength(2);
    });

    it('refuses a manuscript as its own section', async () => {
      const manuscriptId = await makeManuscript(harness.pool, 'Recursive', 'private');
      expect(await addSection(harness.pool, manuscriptId, manuscriptId)).toEqual({
        ok: false,
        reason: 'self',
      });

      const other = await makeManuscript(harness.pool, 'Another', 'private');
      expect(await addSection(harness.pool, manuscriptId, other)).toEqual({
        ok: false,
        reason: 'unknown_item',
      });
    });

    it('reorders densely, so repeated moves cannot collide or drift', async () => {
      const { manuscriptId } = await mixedManuscript();
      const before = await listSections(harness.pool, manuscriptId, admin);
      const middle = before[1]!;

      expect(await moveSection(harness.pool, manuscriptId, middle.id, 'up')).toBe(true);
      const after = await listSections(harness.pool, manuscriptId, admin);
      expect(after[0]?.id).toBe(middle.id);
      expect(after.map((section) => section.position)).toEqual([0, 1, 2]);

      // Moving past the end is refused rather than silently ignored.
      expect(await moveSection(harness.pool, manuscriptId, middle.id, 'up')).toBe(false);
    });

    it('clamps depth to the maximum rather than storing a deeper value', async () => {
      const { manuscriptId } = await mixedManuscript();
      const sections = await listSections(harness.pool, manuscriptId, admin);
      const target = sections[0]!;

      await updateSection(harness.pool, manuscriptId, target.id, { depth: 99 });
      const updated = await listSections(harness.pool, manuscriptId, admin);
      expect(updated[0]?.depth).toBe(5);

      await updateSection(harness.pool, manuscriptId, target.id, { depth: -3 });
      expect((await listSections(harness.pool, manuscriptId, admin))[0]?.depth).toBe(0);
    });

    it('uses a title override in the outline without renaming the piece', async () => {
      const { manuscriptId } = await mixedManuscript();
      const sections = await listSections(harness.pool, manuscriptId, admin);

      await updateSection(harness.pool, manuscriptId, sections[0]!.id, {
        titleOverride: 'Chapter One',
      });

      const updated = await listSections(harness.pool, manuscriptId, admin);
      expect(updated[0]?.title).toBe('Chapter One');
      expect(updated[0]?.ownTitle).toBe('Opening Chapter');
    });
  });

  describe('assembly', () => {
    it('assembles only what the viewer may read, at the right heading levels', async () => {
      const { manuscriptId } = await mixedManuscript();
      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;

      const asAdmin = await assembleDocument(harness.pool, manuscript, admin);
      expect(asAdmin.sectionCount).toBe(3);
      expect(asAdmin.markdown).toContain('Unpublished Chapter');
      expect(asAdmin.markdown).toContain('A confidential finding.');

      const asPublic = await assembleDocument(harness.pool, manuscript, ANONYMOUS);
      expect(asPublic.sectionCount).toBe(2);
      expect(asPublic.markdown).not.toContain('Unpublished');
      expect(asPublic.markdown).not.toContain('confidential');

      // Section headings sit at depth + 1; a body `#` is demoted below its
      // section's own heading rather than competing with it.
      expect(asAdmin.markdown).toContain('# Opening Chapter {#sec-essay-opening-chapter}');
      expect(asAdmin.markdown).toContain('## Opening');
      expect(asAdmin.markdown).toContain('## Unpublished Chapter {#sec-essay-unpublished-chapter}');
      expect(asAdmin.markdown).toContain('### Withheld');
    });

    it('orders front matter, body, appendices and back matter regardless of position', async () => {
      const manuscriptId = await makeManuscript(harness.pool, 'Ordered', 'private');
      const body = await makeEssay(harness.pool, 'Body Chapter', 'public', 'Body.');
      const back = await makeEssay(harness.pool, 'Back Matter', 'public', 'Back.');
      const front = await makeEssay(harness.pool, 'Front Matter', 'public', 'Front.');

      // Added deliberately out of reading order.
      await addSection(harness.pool, manuscriptId, back.id, { role: 'back_matter' });
      await addSection(harness.pool, manuscriptId, body.id, { role: 'body' });
      await addSection(harness.pool, manuscriptId, front.id, { role: 'front_matter' });

      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;
      const { markdown } = await assembleDocument(harness.pool, manuscript, admin);

      expect(markdown.indexOf('Front Matter')).toBeLessThan(markdown.indexOf('Body Chapter'));
      expect(markdown.indexOf('Body Chapter')).toBeLessThan(markdown.indexOf('Back Matter'));
    });

    it('converts citations to Pandoc syntax and carries exactly the cited sources', async () => {
      await makeSource(harness.pool, 'The Hooligan Year', 'public');
      await makeSource(harness.pool, 'An Uncited Book', 'public');

      const manuscriptId = await makeManuscript(harness.pool, 'Cited', 'private');
      const essay = await makeEssay(
        harness.pool,
        'Citing Chapter',
        'public',
        'As argued.[[cite:the-hooligan-year|45-47]] And again.[[cite:the-hooligan-year]]',
      );
      await addSection(harness.pool, manuscriptId, essay.id);

      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;
      const document = await assembleDocument(harness.pool, manuscript, admin);

      expect(document.markdown).toContain('[@the-hooligan-year, 45-47]');
      expect(document.markdown).toContain('[@the-hooligan-year]');
      expect(document.markdown).not.toContain('[[cite:');

      // One entry per cited source, and nothing that was not cited.
      expect(document.bibliography.map((item) => item.id)).toEqual(['the-hooligan-year']);
      expect(document.withheldCitations).toEqual([]);
    });

    it('withholds a private source from a public bibliography instead of naming it', async () => {
      await makeSource(harness.pool, 'A Restricted File', 'private');
      const manuscriptId = await makeManuscript(harness.pool, 'Sensitive', 'public');
      const essay = await makeEssay(
        harness.pool,
        'Chapter',
        'public',
        'Argued.[[cite:a-restricted-file|3]]',
      );
      await addSection(harness.pool, manuscriptId, essay.id);

      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;

      const asPublic = await assembleDocument(harness.pool, manuscript, ANONYMOUS);
      expect(asPublic.bibliography).toEqual([]);
      expect(asPublic.withheldCitations).toEqual(['a-restricted-file']);
      // The title must not appear anywhere in what would become a footnote.
      expect(JSON.stringify(asPublic)).not.toContain('Restricted File');

      const asAdmin = await assembleDocument(harness.pool, manuscript, admin);
      expect(asAdmin.bibliography.map((item) => item.id)).toEqual(['a-restricted-file']);
      expect(asAdmin.withheldCitations).toEqual([]);
    });

    it('cross-references a mention of another section and prints other mentions as text', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      expect(person).toBeGreaterThan(0);

      const manuscriptId = await makeManuscript(harness.pool, 'Linked', 'private');
      const conclusion = await makeEssay(harness.pool, 'Conclusion', 'public', 'The end.');
      const opening = await makeEssay(
        harness.pool,
        'Opening',
        'public',
        'On [[person:ion-antonescu]], see [[essay:conclusion]].',
      );

      await addSection(harness.pool, manuscriptId, opening.id);
      await addSection(harness.pool, manuscriptId, conclusion.id);

      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;
      const { markdown } = await assembleDocument(harness.pool, manuscript, admin);

      // A person is not part of this document, so their name prints as prose.
      expect(markdown).toContain('On Ion Antonescu');
      // A section of this same document becomes an internal cross-reference.
      expect(markdown).toContain('[Conclusion](#sec-essay-conclusion)');
    });
  });

  describe('builds', () => {
    it('records the audience it was assembled for and stages only that content', async () => {
      const { manuscriptId } = await mixedManuscript();
      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;

      const asAdmin = await requestBuild(harness.pool, harness.config, manuscript, {
        format: 'html',
        audience: 'admin',
        requestedBy: harness.userId,
      });
      const asPublic = await requestBuild(harness.pool, harness.config, manuscript, {
        format: 'html',
        audience: 'public',
        requestedBy: harness.userId,
      });

      expect(asAdmin.sectionCount).toBe(3);
      expect(asPublic.sectionCount).toBe(2);

      const { readFile } = await import('node:fs/promises');
      const publicDocument = await readFile(
        resolveStoragePath(STORAGE_ROOT, stagingKey(asPublic.buildId, 'document.md')),
        'utf8',
      );
      expect(publicDocument).not.toContain('Unpublished');
      expect(publicDocument).not.toContain('confidential');

      const adminDocument = await readFile(
        resolveStoragePath(STORAGE_ROOT, stagingKey(asAdmin.buildId, 'document.md')),
        'utf8',
      );
      expect(adminDocument).toContain('Unpublished Chapter');

      const rows = await queryRows<RowDataPacket & { id: number; audience: string; state: string }>(
        harness.pool,
        'SELECT id, audience, state FROM manuscript_build ORDER BY id',
        [],
      );
      expect(rows.map((row) => row.audience)).toEqual(['admin', 'public']);
      expect(rows.every((row) => row.state === 'pending')).toBe(true);
    });

    it('enqueues the compile job only alongside staged input', async () => {
      const { manuscriptId } = await mixedManuscript();
      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;
      const build = await requestBuild(harness.pool, harness.config, manuscript, {
        format: 'docx',
        audience: 'admin',
        requestedBy: harness.userId,
      });

      const jobs = await queryRows<RowDataPacket & { kind: string; payload: unknown }>(
        harness.pool,
        `SELECT kind, payload FROM job WHERE kind = 'manuscript.compile'`,
        [],
      );
      expect(jobs).toHaveLength(1);

      const payload =
        typeof jobs[0]?.payload === 'string'
          ? (JSON.parse(jobs[0].payload) as { buildId: number })
          : (jobs[0]?.payload as { buildId: number });
      expect(payload.buildId).toBe(build.buildId);

      // Both staging files exist by the time the job row is visible.
      const { stat } = await import('node:fs/promises');
      for (const name of ['document.md', 'references.json']) {
        await expect(
          stat(resolveStoragePath(STORAGE_ROOT, stagingKey(build.buildId, name))),
        ).resolves.toBeTruthy();
      }
    });

    it('is not downloadable without an authenticated admin session', async () => {
      const { manuscriptId } = await mixedManuscript();
      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;
      const build = await requestBuild(harness.pool, harness.config, manuscript, {
        format: 'html',
        audience: 'admin',
        requestedBy: harness.userId,
      });

      // Pretend the worker finished: store an output and mark it succeeded.
      const stored = await storeBuffer(STORAGE_ROOT, Buffer.from('<h1>Unpublished Chapter</h1>'));
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

      const url = `/admin/manuscripts/${manuscriptId}/builds/${build.buildId}/download`;

      const anonymous = await harness.app.inject({ method: 'GET', url });
      expect(anonymous.statusCode).toBe(302);
      expect(anonymous.headers.location).toBe('/login');
      expect(anonymous.body).not.toContain('Unpublished');

      // The compiled bytes are not reachable through the public file route
      // either: no artifact owns them, so it 404s.
      const viaFiles = await harness.app.inject({
        method: 'GET',
        url: `/files/${fileObjectId}/original`,
      });
      expect(viaFiles.statusCode).toBe(404);

      const jar = await signIn(harness);
      const authenticated = await harness.app.inject({
        method: 'GET',
        url,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.headers['content-disposition']).toBe(
        `attachment; filename="manuscript-admin-${build.buildId}.html"`,
      );
      expect(authenticated.headers['cache-control']).toBe('private, no-store');
      expect(authenticated.headers['x-content-type-options']).toBe('nosniff');
      expect(authenticated.body).toContain('Unpublished Chapter');
    });

    it('404s a build that belongs to another manuscript', async () => {
      const { manuscriptId } = await mixedManuscript();
      const other = await makeManuscript(harness.pool, 'Unrelated', 'private');
      const manuscript = (await findManuscriptById(harness.pool, manuscriptId, admin))!;
      const build = await requestBuild(harness.pool, harness.config, manuscript, {
        format: 'html',
        audience: 'admin',
        requestedBy: harness.userId,
      });

      const jar = await signIn(harness);
      const response = await harness.app.inject({
        method: 'GET',
        url: `/admin/manuscripts/${other}/builds/${build.buildId}/download`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('file serving', () => {
    async function artifactWithFile(
      visibility: 'public' | 'private',
      title: string,
    ): Promise<{ artifactId: number; fileObjectId: number }> {
      const artifactId = await createArtifact(harness.pool, {
        title,
        titleOriginal: '',
        language: '',
        summary: '',
        visibility,
        noindex: false,
        provenance: '',
        repositoryName: '',
        physicalLocation: '',
        dateCreated: '',
        creditLine: '',
        rightsStatement: '',
      });

      const stored = await storeBuffer(
        STORAGE_ROOT,
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from(title),
        ]),
      );
      const fileObjectId = await insertFileObject(harness.pool, {
        sha256: stored.sha256,
        byteSize: stored.byteSize,
        mimeType: 'image/png',
        originalFilename: 'scan.png',
        storageKey: stored.storageKey,
      });
      await attachFile(harness.pool, artifactId, fileObjectId);
      return { artifactId, fileObjectId };
    }

    it('serves a public artifact file and 404s a private one', async () => {
      const open = await artifactWithFile('public', 'Open Scan');
      const closed = await artifactWithFile('private', 'Closed Scan');

      const served = await harness.app.inject({
        method: 'GET',
        url: `/files/${open.fileObjectId}/original`,
      });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toContain('image/png');
      // An uploaded SVG or HTML must not execute in this origin.
      expect(served.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(served.headers['x-content-type-options']).toBe('nosniff');

      // 404, never 403: a 403 would confirm the file exists.
      const refused = await harness.app.inject({
        method: 'GET',
        url: `/files/${closed.fileObjectId}/original`,
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.body).not.toContain('Closed Scan');

      const jar = await signIn(harness);
      const asAdmin = await harness.app.inject({
        method: 'GET',
        url: `/files/${closed.fileObjectId}/original`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(asAdmin.statusCode).toBe(200);
    });

    it('follows the owning item when its visibility changes', async () => {
      const { artifactId, fileObjectId } = await artifactWithFile('public', 'Later Withdrawn');

      const before = await harness.app.inject({
        method: 'GET',
        url: `/files/${fileObjectId}/original`,
      });
      expect(before.statusCode).toBe(200);

      await execute(harness.pool, `UPDATE content_item SET visibility = 'private' WHERE id = ?`, [
        artifactId,
      ]);

      // Re-checked on every request, not cached from the first one.
      const after = await harness.app.inject({
        method: 'GET',
        url: `/files/${fileObjectId}/original`,
      });
      expect(after.statusCode).toBe(404);
    });

    it('404s an unknown id, an unknown variant and a malformed request', async () => {
      const { fileObjectId } = await artifactWithFile('public', 'Present Scan');

      for (const url of [
        `/files/${fileObjectId}/thumb`,
        '/files/999999/original',
        '/files/0/original',
        '/files/-1/original',
        '/files/abc/original',
        `/files/${fileObjectId}/..%2f..%2fetc`,
      ]) {
        const response = await harness.app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(404);
      }
    });
  });
});
