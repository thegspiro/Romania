/**
 * What a compiled document is allowed to contain.
 *
 * A compiled file holds many sections at once, so it is the one output where a
 * mistake discloses everything to everyone who opens it. `audience` records
 * which viewer the document was assembled for -- but that only helps if the
 * assembly actually withholds what that viewer may not see, and in two places
 * it did not:
 *
 *   - a bare `[[person:x]]` to a private person printed the person's catalogue
 *     title, which is the same defect fixed on the page and in the stored
 *     context snippet;
 *   - a citation to a private source was dropped from the bibliography but
 *     still emitted as `[@slug]`, printing the slug and leaving Pandoc a key
 *     pointing at nothing.
 *
 * Both are pinned here against a real assembly rather than against the rewrite
 * in isolation, because the bug was in what `assembleDocument` handed the
 * rewrite, not in the rewrite itself.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, databaseAvailable, truncateContent, type Harness } from './helpers.js';
import { createEssay } from '../../src/content/essays.js';
import { createEntity } from '../../src/content/entities.js';
import { createSource } from '../../src/content/sources.js';
import {
  addSection,
  assembleDocument,
  createManuscript,
  findManuscriptById,
  WITHHELD_IN_PANDOC,
} from '../../src/content/manuscripts.js';
import { adminViewer, ANONYMOUS, type Visibility } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('compiled document assembly', () => {
  let harness: Harness;
  const admin = adminViewer(1);

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
  });

  async function person(title: string, visibility: Visibility): Promise<number> {
    const { id } = await createEntity(harness.pool, 'person', {
      title,
      titleOriginal: '',
      language: '',
      summary: '',
      visibility,
      noindex: false,
      detail: {},
    });
    return id;
  }

  async function source(title: string, visibility: Visibility): Promise<number> {
    return createSource(harness.pool, {
      title,
      titleOriginal: '',
      summary: '',
      visibility,
      noindex: false,
      cslType: 'book',
      language: '',
      authors: 'Doe, Jane',
      editors: '',
      translators: '',
      containerTitle: '',
      collectionTitle: '',
      publisher: '',
      publisherPlace: '',
      volume: '',
      issue: '',
      page: '',
      edition: '',
      genre: '',
      medium: '',
      issued: '1943',
      accessed: '',
      archive: '',
      archiveLocation: '',
      callNumber: '',
      url: '',
      doi: '',
      isbn: '',
      note: '',
    });
  }

  /** A one-chapter manuscript whose chapter carries `body`. */
  async function manuscriptWith(body: string): Promise<number> {
    const { id: essayId } = await createEssay(harness.pool, {
      title: 'Chapter One',
      titleOriginal: '',
      language: 'en',
      summary: '',
      visibility: 'public',
      noindex: false,
      bodyMarkdown: body,
      status: 'final',
    });
    const manuscriptId = await createManuscript(harness.pool, {
      title: 'The Dissertation',
      subtitle: '',
      summary: '',
      visibility: 'public',
      noindex: false,
      authorName: 'A Researcher',
      degree: 'PhD',
      institution: 'A University',
      submittedOn: '',
      abstractMarkdown: '',
      acknowledgementsMarkdown: '',
      numberSections: true,
    });
    await addSection(harness.pool, manuscriptId, essayId, {});
    return manuscriptId;
  }

  async function assemble(manuscriptId: number, viewer = ANONYMOUS) {
    const manuscript = await findManuscriptById(harness.pool, manuscriptId, admin);
    expect(manuscript).not.toBeNull();
    return assembleDocument(harness.pool, manuscript!, viewer);
  }

  describe('a withheld mention', () => {
    it('never prints the catalogue title into a public build', async () => {
      await person('Maria Doe (informant, dosar 2231)', 'private');
      const id = await manuscriptWith(
        'The witness [[person:maria-doe-informant-dosar-2231]] spoke at dawn.',
      );

      const { markdown } = await assemble(id);

      expect(markdown).not.toContain('Maria Doe');
      expect(markdown).not.toContain('dosar 2231');
      // Nor the slug, read as words or otherwise.
      expect(markdown).not.toContain('maria-doe');
      expect(markdown).not.toContain('maria doe');
      expect(markdown).toContain(WITHHELD_IN_PANDOC);
      expect(markdown).toContain('spoke at dawn');
    });

    it('keeps the words the prose itself used', async () => {
      await person('Maria Doe', 'private');
      const id = await manuscriptWith('The witness [[person:maria-doe|a neighbour]] spoke.');

      const { markdown } = await assemble(id);
      expect(markdown).toContain('a neighbour');
      expect(markdown).not.toContain('Maria Doe');
    });

    it('prints the title for an admin build, where the target is visible', async () => {
      await person('Maria Doe', 'private');
      const id = await manuscriptWith('The witness [[person:maria-doe]] spoke.');

      const { markdown } = await assemble(id, admin);
      expect(markdown).toContain('Maria Doe');
      expect(markdown).not.toContain(WITHHELD_IN_PANDOC);
    });

    it('still prints a public person by name', async () => {
      await person('Ion Antonescu', 'public');
      const id = await manuscriptWith('The order from [[person:ion-antonescu]] arrived.');

      const { markdown } = await assemble(id);
      expect(markdown).toContain('Ion Antonescu');
      expect(markdown).not.toContain(WITHHELD_IN_PANDOC);
    });

    it('still reads a broken reference as the operator typed it', async () => {
      // Nothing resolved, so there is no record to protect and the slug is
      // their own typing.
      const id = await manuscriptWith('The witness [[person:no-such-person]] spoke.');

      const { markdown } = await assemble(id);
      expect(markdown).toContain('no such person');
    });
  });

  describe('a withheld citation', () => {
    it('emits no citation key and no slug for a private source', async () => {
      await source('A Private File', 'private');
      const id = await manuscriptWith('As argued.[[cite:a-private-file|45-47]] Then dawn.');

      const { markdown, bibliography, withheldCitations } = await assemble(id);

      expect(markdown).not.toContain('a-private-file');
      expect(markdown).not.toContain('@');
      expect(markdown).not.toContain('A Private File');
      expect(markdown).toContain(WITHHELD_IN_PANDOC);

      // Still absent from the bibliography, and still reported to the operator
      // so they can see what their own document lost.
      expect(bibliography).toHaveLength(0);
      expect(withheldCitations).toEqual(['a-private-file']);
    });

    it('emits a normal citation key for a public source', async () => {
      await source('The Hooligan Year', 'public');
      const id = await manuscriptWith('As argued.[[cite:the-hooligan-year|45-47]]');

      const { markdown, bibliography, withheldCitations } = await assemble(id);

      expect(markdown).toContain('[@the-hooligan-year, 45-47]');
      expect(bibliography).toHaveLength(1);
      expect(withheldCitations).toEqual([]);
    });

    it('cites a public source and withholds a private one in the same sentence', async () => {
      await source('The Hooligan Year', 'public');
      await source('A Private File', 'private');
      const id = await manuscriptWith(
        'One claim.[[cite:the-hooligan-year]] Another.[[cite:a-private-file]]',
      );

      const { markdown, bibliography, withheldCitations } = await assemble(id);
      expect(markdown).toContain('[@the-hooligan-year]');
      expect(markdown).toContain(WITHHELD_IN_PANDOC);
      expect(markdown).not.toContain('a-private-file');
      expect(bibliography).toHaveLength(1);
      expect(withheldCitations).toEqual(['a-private-file']);
    });

    it('keeps the admin build citing everything', async () => {
      await source('A Private File', 'private');
      const id = await manuscriptWith('As argued.[[cite:a-private-file]]');

      const { markdown, bibliography, withheldCitations } = await assemble(id, admin);
      expect(markdown).toContain('[@a-private-file]');
      expect(bibliography).toHaveLength(1);
      expect(withheldCitations).toEqual([]);
    });
  });
});
