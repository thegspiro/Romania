/**
 * An artifact carrying the text of the document it photographs.
 *
 * The column is the small half. The decision worth pinning is that a
 * transcription is **prose**: references written inside it are projected into
 * `mention` by `rebuildReferences`, in the same transaction as the save, so a
 * photographed order naming somebody reaches that person's page like any other
 * writing. That also means it inherits the renderer's rule — a reference to
 * something the viewer may not see comes back as escaped text with no href and
 * no slug.
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
import { queryRows } from '../../src/db/pool.js';
import {
  createArtifact,
  findArtifactById,
  listArtifacts,
  updateArtifact,
} from '../../src/content/artifacts.js';
import { createEntity } from '../../src/content/entities.js';
import { adminViewer, ANONYMOUS, type Visibility } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('artifact transcriptions', () => {
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

  function artifactInput(overrides: Record<string, unknown> = {}) {
    return {
      title: 'Report of 22 June',
      titleOriginal: '',
      language: 'ro',
      summary: '',
      visibility: 'private' as Visibility,
      noindex: false,
      provenance: '',
      repositoryName: 'Arhivele Naționale ale României',
      physicalLocation: 'București',
      dateCreated: '1941',
      creditLine: '',
      rightsStatement: '',
      transcription: '',
      transcriptionLanguage: '',
      ...overrides,
    };
  }

  async function person(title: string, visibility: Visibility): Promise<void> {
    await createEntity(harness.pool, 'person', {
      title,
      titleOriginal: '',
      language: '',
      summary: '',
      visibility,
      noindex: false,
      detail: {},
    });
  }

  async function mentionsFrom(artifactId: number): Promise<RowDataPacket[]> {
    return queryRows<RowDataPacket>(
      harness.pool,
      'SELECT to_item_id, block_index FROM mention WHERE from_item_id = ?',
      [artifactId],
    );
  }

  // --- Storing -------------------------------------------------------------

  it('stores and reads back a transcription', async () => {
    const id = await createArtifact(
      harness.pool,
      artifactInput({
        transcription: 'Ordin nr. 536. Se dispune evacuarea.',
        transcriptionLanguage: 'ro',
      }),
    );

    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));
    expect(artifact?.transcription).toBe('Ordin nr. 536. Se dispune evacuarea.');
    expect(artifact?.transcriptionLanguage).toBe('ro');
  });

  it('reads back null when nothing has been typed', async () => {
    const id = await createArtifact(harness.pool, artifactInput());
    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));

    expect(artifact?.transcription).toBeNull();
    expect(artifact?.transcriptionLanguage).toBeNull();
  });

  it('keeps the text language separate from the record language', async () => {
    // A German order in a Romanian archive has a Romanian catalogue entry and
    // a German text; collapsing the two would mislabel one of them.
    const id = await createArtifact(
      harness.pool,
      artifactInput({
        language: 'ro',
        transcription: 'Befehl Nr. 12.',
        transcriptionLanguage: 'de',
      }),
    );

    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));
    expect(artifact?.language).toBe('ro');
    expect(artifact?.transcriptionLanguage).toBe('de');
  });

  it('survives an artifact created without one', async () => {
    // ArtifactInput's new fields are optional, so callers that predate them
    // still compile and still work.
    const id = await createArtifact(harness.pool, {
      title: 'An Untranscribed Photograph',
      titleOriginal: '',
      language: '',
      summary: '',
      visibility: 'private',
      noindex: false,
      provenance: '',
      repositoryName: '',
      physicalLocation: '',
      dateCreated: '',
      creditLine: '',
      rightsStatement: '',
    });

    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));
    expect(artifact?.transcription).toBeNull();
  });

  // --- It is prose ---------------------------------------------------------

  it('projects references written inside it into mentions', async () => {
    await person('Ion Antonescu', 'public');
    const id = await createArtifact(
      harness.pool,
      artifactInput({
        transcription: 'Semnat de [[person:ion-antonescu|Antonescu]].',
      }),
    );

    const mentions = await mentionsFrom(id);
    expect(mentions).toHaveLength(1);
    // 1-based, matching the `#pN` anchors renderProse emits, so a backlink
    // lands on the paragraph that named the person.
    expect(Number(mentions[0]?.block_index)).toBe(1);
  });

  it('rebuilds the projection wholesale on every save', async () => {
    await person('Ion Antonescu', 'public');
    await person('Mihai Antonescu', 'public');

    const id = await createArtifact(
      harness.pool,
      artifactInput({ transcription: 'Semnat de [[person:ion-antonescu]].' }),
    );
    expect(await mentionsFrom(id)).toHaveLength(1);

    await updateArtifact(
      harness.pool,
      id,
      artifactInput({ transcription: 'Semnat de [[person:mihai-antonescu]].' }),
    );

    // Not two: the projection is torn down and rebuilt from the prose, so it
    // cannot describe an older version of the text.
    const after = await mentionsFrom(id);
    expect(after).toHaveLength(1);
  });

  it('drops every mention when the transcription is cleared', async () => {
    await person('Ion Antonescu', 'public');
    const id = await createArtifact(
      harness.pool,
      artifactInput({ transcription: 'Semnat de [[person:ion-antonescu]].' }),
    );

    await updateArtifact(harness.pool, id, artifactInput({ transcription: '' }));
    expect(await mentionsFrom(id)).toHaveLength(0);
  });

  it('surfaces a public artifact on the page of the person it names', async () => {
    await person('Ion Antonescu', 'public');
    const id = await createArtifact(
      harness.pool,
      artifactInput({
        visibility: 'public',
        transcription: 'Semnat de [[person:ion-antonescu|Antonescu]].',
      }),
    );

    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));
    const response = await harness.app.inject({ method: 'GET', url: '/people/ion-antonescu' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(artifact?.title ?? 'unreachable');
  });

  it('does not surface a private artifact on a public person page', async () => {
    // Backlinks filter on the citing item. A private transcription naming a
    // public person must not appear on that person's public page.
    await person('Ion Antonescu', 'public');
    const id = await createArtifact(
      harness.pool,
      artifactInput({
        title: 'An Unpublished Order',
        visibility: 'private',
        transcription: 'Semnat de [[person:ion-antonescu]].',
      }),
    );
    expect(await mentionsFrom(id)).toHaveLength(1);

    const response = await harness.app.inject({ method: 'GET', url: '/people/ion-antonescu' });
    expect(response.body).not.toContain('An Unpublished Order');
  });

  // --- Rendering -----------------------------------------------------------

  it('renders the transcription as prose on the public page', async () => {
    await person('Ion Antonescu', 'public');
    const id = await createArtifact(
      harness.pool,
      artifactInput({
        visibility: 'public',
        transcription: 'Semnat de [[person:ion-antonescu|Antonescu]].',
        transcriptionLanguage: 'ro',
      }),
    );

    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));
    const response = await harness.app.inject({
      method: 'GET',
      url: `/artifacts/${artifact?.slug}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Transcription');
    expect(response.body).toContain('href="/people/ion-antonescu"');
    expect(response.body).toContain('lang="ro"');
  });

  it('withholds a reference the reader may not follow', async () => {
    // The renderer's rule, inherited rather than reimplemented: escaped
    // display text and nothing else -- no href, no slug.
    await person('A Private Person', 'private');
    const id = await createArtifact(
      harness.pool,
      artifactInput({
        visibility: 'public',
        transcription: 'Semnat de [[person:a-private-person|the signatory]].',
      }),
    );

    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));
    const response = await harness.app.inject({
      method: 'GET',
      url: `/artifacts/${artifact?.slug}`,
    });

    expect(response.body).toContain('the signatory');
    expect(response.body).not.toContain('a-private-person');
    expect(response.body).not.toContain('A Private Person');
  });

  it('escapes markup in a transcription rather than rendering it', async () => {
    const id = await createArtifact(
      harness.pool,
      artifactInput({ visibility: 'public', transcription: '<script>alert(1)</script>' }),
    );

    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));
    const response = await harness.app.inject({
      method: 'GET',
      url: `/artifacts/${artifact?.slug}`,
    });

    expect(response.body).not.toContain('<script>alert(1)</script>');
  });

  it('shows no transcription section when there is no text', async () => {
    const id = await createArtifact(harness.pool, artifactInput({ visibility: 'public' }));
    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));

    const response = await harness.app.inject({
      method: 'GET',
      url: `/artifacts/${artifact?.slug}`,
    });
    expect(response.body).not.toContain('<h2>Transcription</h2>');
  });

  // --- Finding it again ----------------------------------------------------

  it('matches a search against the transcription', async () => {
    // The reason to type one at all: a photograph is otherwise unsearchable.
    await createArtifact(
      harness.pool,
      artifactInput({ title: 'Photograph 44', transcription: 'Se dispune evacuarea satului.' }),
    );
    await createArtifact(harness.pool, artifactInput({ title: 'Photograph 45' }));

    const found = await listArtifacts(harness.pool, adminViewer(harness.userId), {
      search: 'evacuarea',
    });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.title).toBe('Photograph 44');
  });

  it('does not match a private transcription for an anonymous search', async () => {
    await createArtifact(
      harness.pool,
      artifactInput({ visibility: 'private', transcription: 'Se dispune evacuarea satului.' }),
    );

    const found = await listArtifacts(harness.pool, ANONYMOUS, { search: 'evacuarea' });
    expect(found.items).toHaveLength(0);
  });

  it('escapes a wildcard typed into the search', async () => {
    await createArtifact(harness.pool, artifactInput({ transcription: 'plain text' }));

    // Unescaped, "%" would match everything.
    const found = await listArtifacts(harness.pool, adminViewer(harness.userId), { search: '%' });
    expect(found.items).toHaveLength(0);
  });

  // --- The editor ----------------------------------------------------------

  it('saves a transcription through the admin form', async () => {
    const create = await getPage(harness, '/admin/artifacts/new', admin);
    const created = await postForm(harness, '/admin/artifacts', admin, {
      title: 'Report of 22 June',
      titleOriginal: '',
      language: 'ro',
      summary: '',
      visibility: 'private',
      provenance: '',
      repositoryName: '',
      physicalLocation: '',
      dateCreated: '',
      creditLine: '',
      rightsStatement: '',
      transcription: 'Ordin nr. 536.',
      transcriptionLanguage: 'ro',
      _csrf: create.csrf,
    });

    const id = Number(/\/admin\/artifacts\/(\d+)\/edit/.exec(created.location ?? '')?.[1]);
    const artifact = await findArtifactById(harness.pool, id, adminViewer(harness.userId));
    expect(artifact?.transcription).toBe('Ordin nr. 536.');

    const edit = await getPage(harness, `/admin/artifacts/${id}/edit`, admin);
    expect(edit.body).toContain('Ordin nr. 536.');
    expect(edit.body).toContain('name="transcriptionLanguage"');
  });
});
