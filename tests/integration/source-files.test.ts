/**
 * A source holding the scan of the work it describes.
 *
 * The change that matters is not the column — it is that `findServableFile`
 * now resolves two kinds of owner. That function is invariant 3 of CLAUDE.md
 * in one query, so this suite spends most of its effort there: a file owned
 * only by a private source must be 404 for a visitor, and a `file_object` no
 * item owns at all must stay unreachable, which is what keeps a compiled
 * manuscript off this route.
 *
 * One consequence is stated rather than discovered: storage is
 * content-addressed, so the same bytes can be owned by several items, and a
 * file is servable if **any** owning item is visible.
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
import {
  attachSourceFile,
  detachSourceFile,
  findSourceById,
  setSourceVisibility,
} from '../../src/content/sources.js';
import { createArtifact } from '../../src/content/artifacts.js';
import { findServableFile } from '../../src/files/repository.js';
import { ANONYMOUS, adminViewer, type Visibility } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('a file on a source', () => {
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

  /** A file_object row plus a derivative, without pushing bytes through HTTP. */
  async function storeFile(seed: string): Promise<number> {
    const sha = seed.repeat(64).slice(0, 64);
    await execute(
      harness.pool,
      `INSERT INTO file_object (sha256, byte_size, mime_type, original_filename, storage_key)
       VALUES (?, 4096, 'application/pdf', 'article.pdf', ?)`,
      [sha, `${sha.slice(0, 2)}/${sha}`],
    );
    const row = await queryOne<RowDataPacket & { id: number }>(
      harness.pool,
      'SELECT id FROM file_object WHERE sha256 = ?',
      [sha],
    );
    if (row === null) throw new Error('seeding a file_object failed');

    await execute(
      harness.pool,
      `INSERT INTO file_derivative
         (file_object_id, variant, mime_type, byte_size, storage_key)
       VALUES (?, 'web', 'image/jpeg', 1024, ?)`,
      [row.id, `${sha.slice(0, 2)}/${sha}-web`],
    );
    return Number(row.id);
  }

  async function artifactOwning(fileId: number, visibility: Visibility): Promise<number> {
    const id = await createArtifact(harness.pool, {
      title: `Artifact for ${fileId}`,
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
    await execute(
      harness.pool,
      'UPDATE artifact_detail SET file_object_id = ? WHERE content_item_id = ?',
      [fileId, id],
    );
    return id;
  }

  // --- The column ----------------------------------------------------------

  it('attaches a file and reads it back on the record', async () => {
    const id = await createSource({ title: 'A Scanned Article' });
    const fileId = await storeFile('a');

    expect(await attachSourceFile(harness.pool, id, fileId)).toBe(true);

    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    expect(source?.fileObjectId).toBe(fileId);
    expect(source?.originalFilename).toBe('article.pdf');
    expect(source?.mimeType).toBe('application/pdf');
    expect(source?.byteSize).toBe(4096);
  });

  it('reads back as no file when none is attached', async () => {
    const id = await createSource({ title: 'A Book Nobody Scanned' });
    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));

    expect(source?.fileObjectId).toBeNull();
    expect(source?.originalFilename).toBeNull();
  });

  it('unlinks the file without deleting it', async () => {
    const id = await createSource({ title: 'A Scanned Article' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    await detachSourceFile(harness.pool, id);

    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    expect(source?.fileObjectId).toBeNull();
    // The bytes are content-addressed and may be owned elsewhere; unlinking is
    // a statement about the record, not about the file.
    const still = await queryOne<RowDataPacket & { total: number }>(
      harness.pool,
      'SELECT COUNT(*) AS total FROM file_object WHERE id = ?',
      [fileId],
    );
    expect(Number(still?.total)).toBe(1);
  });

  it('keeps the record when the file row is deleted', async () => {
    const id = await createSource({ title: 'A Scanned Article' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    // ON DELETE SET NULL, like artifact_detail: losing the bytes must not
    // silently delete the bibliographic record that describes them.
    await execute(harness.pool, 'DELETE FROM file_object WHERE id = ?', [fileId]);

    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    expect(source).not.toBeNull();
    expect(source?.fileObjectId).toBeNull();
    expect(source?.title).toBe('A Scanned Article');
  });

  // --- Who may read the bytes ----------------------------------------------

  it('serves a file owned by a public source', async () => {
    const id = await createSource({ title: 'A Scanned Article', visibility: 'public' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    const file = await findServableFile(harness.pool, fileId, 'original', ANONYMOUS);
    expect(file?.originalFilename).toBe('article.pdf');
  });

  it('refuses a file owned only by a private source', async () => {
    const id = await createSource({ title: 'A Scanned Article', visibility: 'private' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    expect(await findServableFile(harness.pool, fileId, 'original', ANONYMOUS)).toBeNull();
    // Visible to the operator, who could already open the source's page.
    expect(
      await findServableFile(harness.pool, fileId, 'original', adminViewer(harness.userId)),
    ).not.toBeNull();
  });

  it('answers 404 rather than 403 over HTTP for a private source file', async () => {
    const id = await createSource({ title: 'A Scanned Article', visibility: 'private' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    const response = await harness.app.inject({ method: 'GET', url: `/files/${fileId}/original` });
    // A 403 would confirm the file exists at that id.
    expect(response.statusCode).toBe(404);
  });

  it('applies the same rule to derivatives', async () => {
    const id = await createSource({ title: 'A Scanned Article', visibility: 'private' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    expect(await findServableFile(harness.pool, fileId, 'web', ANONYMOUS)).toBeNull();

    await setSourceVisibility(harness.pool, id, 'public');
    expect(await findServableFile(harness.pool, fileId, 'web', ANONYMOUS)).not.toBeNull();
  });

  it('withdraws the bytes when the source is unpublished', async () => {
    const id = await createSource({ title: 'A Scanned Article', visibility: 'public' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);
    expect(await findServableFile(harness.pool, fileId, 'original', ANONYMOUS)).not.toBeNull();

    await setSourceVisibility(harness.pool, id, 'private');

    // The decision is re-made per request, so no URL handed out earlier keeps
    // working.
    expect(await findServableFile(harness.pool, fileId, 'original', ANONYMOUS)).toBeNull();
  });

  it('stays unreachable when nothing owns the file', async () => {
    // A compiled manuscript build is exactly this case, and must not become
    // reachable through this route because sources were added to the join.
    const fileId = await storeFile('a');

    expect(await findServableFile(harness.pool, fileId, 'original', ANONYMOUS)).toBeNull();
    expect(
      await findServableFile(harness.pool, fileId, 'original', adminViewer(harness.userId)),
    ).toBeNull();
  });

  it('is servable when any owner is visible, even if another is not', async () => {
    // Storage is content-addressed, so one file_object can be owned by several
    // items. Publishing the artifact publishes the bytes; there is no coherent
    // way for the same bytes to be public and private at once. Stated here so
    // it reads as a decision rather than an accident of the join.
    const fileId = await storeFile('a');
    const source = await createSource({ title: 'A Private Source', visibility: 'private' });
    await attachSourceFile(harness.pool, source, fileId);
    await artifactOwning(fileId, 'public');

    expect(await findServableFile(harness.pool, fileId, 'original', ANONYMOUS)).not.toBeNull();
  });

  it('refuses when every owner is private', async () => {
    const fileId = await storeFile('a');
    const source = await createSource({ title: 'A Private Source', visibility: 'private' });
    await attachSourceFile(harness.pool, source, fileId);
    await artifactOwning(fileId, 'private');

    expect(await findServableFile(harness.pool, fileId, 'original', ANONYMOUS)).toBeNull();
  });

  // --- The pages -----------------------------------------------------------

  it('offers the file on the public source page', async () => {
    const id = await createSource({ title: 'A Scanned Article', visibility: 'public' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    const response = await harness.app.inject({ method: 'GET', url: `/sources/${source?.slug}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`/files/${fileId}/original`);
    expect(response.body).toContain('article.pdf');
  });

  it('does not name the file on a page the visitor cannot see', async () => {
    const id = await createSource({ title: 'A Scanned Article', visibility: 'private' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    const response = await harness.app.inject({ method: 'GET', url: `/sources/${source?.slug}` });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('article.pdf');
  });

  it('shows the attach form on the editor', async () => {
    const id = await createSource({ title: 'A Scanned Article' });
    const page = await getPage(harness, `/admin/sources/${id}/edit`, admin);

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`/admin/sources/${id}/file`);
    expect(page.body).toContain('enctype="multipart/form-data"');
  });

  it('needs a CSRF token to unlink a file', async () => {
    const id = await createSource({ title: 'A Scanned Article' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    const result = await postForm(harness, `/admin/sources/${id}/file/detach`, admin, {});
    expect(result.statusCode).toBe(403);

    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    expect(source?.fileObjectId).toBe(fileId);
  });

  it('does not let a signed-out request unlink a file', async () => {
    const id = await createSource({ title: 'A Scanned Article' });
    const fileId = await storeFile('a');
    await attachSourceFile(harness.pool, id, fileId);

    const result = await postForm(harness, `/admin/sources/${id}/file/detach`, new Map(), {});
    expect(result.statusCode).toBeGreaterThanOrEqual(300);

    const source = await findSourceById(harness.pool, id, adminViewer(harness.userId));
    expect(source?.fileObjectId).toBe(fileId);
  });
});
