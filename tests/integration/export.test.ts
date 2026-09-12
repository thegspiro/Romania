/**
 * Exporting the corpus to formats that outlive this application.
 *
 * Two things have to hold. The export must be **complete** — prose as
 * Markdown, the bibliography as CSL-JSON an importer will actually accept,
 * and enough about each artifact to find its file in a backup archive. And it
 * must obey the same visibility rule as everything else: a `--public` export
 * is assembled for an anonymous reader, so it can contain only what a visitor
 * could already read one page at a time.
 *
 * The second is the one worth testing hardest. An export is a single
 * directory holding everything at once, which makes it the same kind of
 * hazard as a compiled manuscript.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { RowDataPacket } from 'mysql2/promise';
import { exportCorpus } from '../../src/content/export.js';
import { createEntity } from '../../src/content/entities.js';
import { createArtifact } from '../../src/content/artifacts.js';
import { ANONYMOUS, adminViewer, type Visibility } from '../../src/content/visibility.js';

const available = await databaseAvailable();

const PUBLIC_PROSE =
  'The commission met in July, chaired by [[person:ion-antonescu|Antonescu]].\n\n' +
  'It reported in the autumn.[[cite:the-hooligan-year|45-47]]';
const PRIVATE_PROSE = 'A working note about [[person:ion-antonescu]] that is not ready.';

describe.skipIf(!available)('corpus export', () => {
  let harness: Harness;
  let admin: Map<string, string>;
  let directory: string;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
    admin = await signIn(harness);
    directory = await mkdtemp(join(tmpdir(), 'dsp-export-'));
  });

  async function createEssay(title: string, body: string, visibility: Visibility): Promise<number> {
    const page = await getPage(harness, '/admin/essays/new', admin);
    const result = await postForm(harness, '/admin/essays', admin, {
      title,
      titleOriginal: '',
      language: 'en',
      summary: 'A summary.',
      visibility,
      bodyMarkdown: body,
      status: 'draft',
      _csrf: page.csrf,
    });
    const id = /\/admin\/essays\/(\d+)\/edit/.exec(result.location ?? '')?.[1];
    if (id === undefined) throw new Error(`create failed: ${result.statusCode}`);
    return Number(id);
  }

  async function createSource(fields: Record<string, string>): Promise<number> {
    const page = await getPage(harness, '/admin/sources/new', admin);
    const result = await postForm(harness, '/admin/sources', admin, {
      ...sourceForm(fields),
      _csrf: page.csrf,
    });
    const id = /\/admin\/sources\/(\d+)\/edit/.exec(result.location ?? '')?.[1];
    if (id === undefined) throw new Error(`create failed: ${result.statusCode}`);
    return Number(id);
  }

  /** An artifact with a file attached, without uploading bytes. */
  async function createArtifactWithFile(title: string, visibility: Visibility): Promise<void> {
    const id = await createArtifact(harness.pool, {
      title,
      titleOriginal: '',
      language: '',
      summary: '',
      visibility,
      noindex: false,
      provenance: 'Arhivele Naționale ale României',
      repositoryName: 'ANR',
      physicalLocation: 'București',
      dateCreated: 'c. 1941',
      creditLine: '',
      rightsStatement: '',
    });

    const sha = 'a'.repeat(64);
    await execute(
      harness.pool,
      `INSERT INTO file_object (sha256, byte_size, mime_type, original_filename, storage_key)
       VALUES (?, 2048, 'image/jpeg', 'dosar-17.jpg', ?)`,
      [sha, `ab/${sha}`],
    );
    const file = await queryOne<RowDataPacket & { id: number }>(
      harness.pool,
      'SELECT id FROM file_object WHERE sha256 = ?',
      [sha],
    );
    if (file === null) throw new Error('seeding a file_object row failed');
    await execute(
      harness.pool,
      'UPDATE artifact_detail SET file_object_id = ? WHERE content_item_id = ?',
      [file.id, id],
    );
  }

  async function seed(): Promise<void> {
    await createEssay('A Public Chapter', PUBLIC_PROSE, 'public');
    await createEssay('An Unfinished Note', PRIVATE_PROSE, 'private');

    await createSource({
      title: 'The Hooligan Year',
      cslType: 'book',
      authors: 'Sebastian, Mihail',
      publisher: 'Humanitas',
      issued: '1996',
      archive: 'Arhivele Naționale ale României',
      callNumber: 'Fond 2242, dosar 17/1941',
      note: 'Read in the reading room; pages 45-47 photographed.',
      visibility: 'public',
    });

    await createEntity(harness.pool, 'person', {
      title: 'Ion Antonescu',
      titleOriginal: '',
      language: '',
      summary: 'Prime minister.',
      visibility: 'public',
      noindex: false,
      detail: { familyName: 'Antonescu', givenName: 'Ion' },
    });

    await createArtifactWithFile('A Photographed Dosar', 'private');
  }

  async function readJson(...parts: string[]): Promise<unknown> {
    return JSON.parse(await readFile(join(directory, ...parts), 'utf8')) as unknown;
  }

  // --- Completeness --------------------------------------------------------

  it('writes prose as Markdown with front matter, body verbatim', async () => {
    await seed();
    await exportCorpus(harness.pool, adminViewer(harness.userId), directory);

    const markdown = await readFile(join(directory, 'essays', 'a-public-chapter.md'), 'utf8');

    expect(markdown.startsWith('---\n')).toBe(true);
    expect(markdown).toContain('title: "A Public Chapter"');
    expect(markdown).toContain('slug: "a-public-chapter"');
    expect(markdown).toContain('visibility: "public"');
    // The body exactly as written, reference syntax included: it is readable
    // as text and keyed to slugs, so it survives without this application.
    expect(markdown).toContain(PUBLIC_PROSE);
    expect(markdown).toContain('[[person:ion-antonescu|Antonescu]]');
    expect(markdown).toContain('[[cite:the-hooligan-year|45-47]]');
  });

  it('writes the bibliography as an importable CSL-JSON array', async () => {
    await seed();
    await exportCorpus(harness.pool, adminViewer(harness.userId), directory);

    const references = (await readJson('sources', 'references.json')) as Record<string, unknown>[];
    expect(Array.isArray(references)).toBe(true);
    expect(references).toHaveLength(1);

    const entry = references[0] as Record<string, unknown>;
    // Zotero and Pandoc both refuse an entry without these two.
    expect(entry.id).toBe('the-hooligan-year');
    expect(entry.type).toBe('book');
    expect(entry.title).toBe('The Hooligan Year');
    // The citation key matches the slug the exported prose cites, so the two
    // files still refer to the same work.
    expect(entry.id).toBe('the-hooligan-year');
  });

  it('keeps archival provenance that CSL cannot carry', async () => {
    await seed();
    await exportCorpus(harness.pool, adminViewer(harness.userId), directory);

    const provenance = (await readJson('sources', 'provenance.json')) as Record<string, unknown>[];
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({
      id: 'the-hooligan-year',
      call_number: 'Fond 2242, dosar 17/1941',
      notes: 'Read in the reading room; pages 45-47 photographed.',
    });
  });

  it('records enough about an artifact to find its file in a backup', async () => {
    await seed();
    await exportCorpus(harness.pool, adminViewer(harness.userId), directory);

    const artifacts = (await readJson('artifacts', 'artifacts.json')) as Record<string, unknown>[];
    expect(artifacts).toHaveLength(1);

    const file = artifacts[0]?.file as Record<string, unknown>;
    // Without the storage key there is no way to match a record to its bytes
    // inside files-*.tar.gz; without the hash, no way to verify them.
    expect(file.storage_key).toBe(`ab/${'a'.repeat(64)}`);
    expect(file.sha256).toBe('a'.repeat(64));
    expect(file.original_filename).toBe('dosar-17.jpg');
  });

  it('exports entities with their detail fields', async () => {
    await seed();
    await exportCorpus(harness.pool, adminViewer(harness.userId), directory);

    const person = await readFile(
      join(directory, 'entities', 'person', 'ion-antonescu.md'),
      'utf8',
    );
    expect(person).toContain('title: "Ion Antonescu"');
    expect(person).toContain('kind: "person"');
    expect(person).toContain('familyName: "Antonescu"');
  });

  it('counts what it wrote in the manifest', async () => {
    await seed();
    const summary = await exportCorpus(harness.pool, adminViewer(harness.userId), directory);

    expect(summary).toMatchObject({
      essays: 2,
      sources: 1,
      artifacts: 1,
      artifactFiles: 1,
      audience: 'admin',
    });
    expect(summary.entities.person).toBe(1);

    const manifest = (await readJson('manifest.json')) as Record<string, unknown>;
    expect(manifest.essays).toBe(2);
    expect(manifest.formatVersion).toBe(1);
    expect(typeof manifest.generatedAt).toBe('string');
  });

  it('explains itself in a README', async () => {
    await seed();
    await exportCorpus(harness.pool, adminViewer(harness.userId), directory);

    const readme = await readFile(join(directory, 'README.md'), 'utf8');
    expect(readme).toContain('CSL-JSON');
    expect(readme).toContain('unpublished material');
  });

  // --- Visibility ----------------------------------------------------------

  it('a public export contains no private prose', async () => {
    await seed();
    await exportCorpus(harness.pool, ANONYMOUS, directory);

    const essays = await readdir(join(directory, 'essays'));
    expect(essays).toEqual(['a-public-chapter.md']);

    // Not the file, not the title, not a sentence of it.
    const everything = await readAll(directory);
    expect(everything).not.toContain('An Unfinished Note');
    expect(everything).not.toContain(PRIVATE_PROSE);
    expect(everything).not.toContain('an-unfinished-note');
  });

  it('a public export contains no private artifact or its storage key', async () => {
    await seed();
    await exportCorpus(harness.pool, ANONYMOUS, directory);

    const artifacts = (await readJson('artifacts', 'artifacts.json')) as unknown[];
    expect(artifacts).toHaveLength(0);

    const everything = await readAll(directory);
    // A storage key is a content hash; leaking one would point at the bytes.
    expect(everything).not.toContain('a'.repeat(64));
    expect(everything).not.toContain('A Photographed Dosar');
  });

  it('records which audience it was assembled for', async () => {
    await seed();
    const summary = await exportCorpus(harness.pool, ANONYMOUS, directory);

    expect(summary.audience).toBe('public');
    const readme = await readFile(join(directory, 'README.md'), 'utf8');
    expect(readme).toContain('only\nmaterial that was already published');
    expect(readme).not.toContain('**This export contains unpublished material.**');
  });

  it('creates the directory unreadable by anyone else', async () => {
    await seed();
    await exportCorpus(harness.pool, adminViewer(harness.userId), directory);

    // A default export holds unpublished research about named people.
    const mode = (await stat(join(directory, 'essays'))).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('exports an empty corpus without failing', async () => {
    const summary = await exportCorpus(harness.pool, adminViewer(harness.userId), directory);

    expect(summary.essays).toBe(0);
    expect(await readJson('sources', 'references.json')).toEqual([]);
  });
});

/** Every exported file's text, for asserting that something is absent. */
async function readAll(directory: string): Promise<string> {
  const parts: string[] = [];

  async function walk(at: string): Promise<void> {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        parts.push(entry.name, await readFile(path, 'utf8'));
      }
    }
  }

  await walk(directory);
  return parts.join('\n');
}
