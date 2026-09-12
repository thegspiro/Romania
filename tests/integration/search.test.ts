/**
 * Search across every kind at once.
 *
 * Two properties carry the weight here, and most of this file is about them:
 *
 *   1. **Every branch of the union filters.** A union is the shape where one
 *      forgotten branch leaks, so there is a case per kind asserting that a
 *      private item of that kind is invisible to a viewer who may not see it.
 *   2. **A snippet never says more than the viewer may see.** Prose contains
 *      `[[person:slug]]`, so a snippet cut from raw Markdown would print a
 *      private person's slug on a results page. The snippet builder is
 *      stricter than `renderProse`: a reference the viewer may not follow
 *      contributes nothing at all.
 *
 * The rest pins the behaviour that would otherwise rot quietly: accent-blind
 * matching (the reason there is no FULLTEXT index), LIKE escaping, and that
 * every word has to appear somewhere rather than just one of them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createHarness,
  databaseAvailable,
  getPage,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { parseSearchQuery, searchCorpus, type SearchHit } from '../../src/content/search.js';
import { createEssay } from '../../src/content/essays.js';
import { createArtifact } from '../../src/content/artifacts.js';
import { createEntity } from '../../src/content/entities.js';
import { adminViewer, ANONYMOUS, type Visibility } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('corpus search', () => {
  let harness: Harness;
  let admin: Map<string, string>;
  const viewer = adminViewer(1);

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

  async function essay(
    title: string,
    body: string,
    visibility: Visibility = 'public',
  ): Promise<number> {
    const { id } = await createEssay(harness.pool, {
      title,
      titleOriginal: '',
      language: 'en',
      summary: '',
      visibility,
      noindex: false,
      bodyMarkdown: body,
      status: 'draft',
    });
    return id;
  }

  async function person(title: string, visibility: Visibility, biography = ''): Promise<number> {
    const { id } = await createEntity(harness.pool, 'person', {
      title,
      titleOriginal: '',
      language: '',
      summary: '',
      visibility,
      noindex: false,
      detail: { biography },
    });
    return id;
  }

  async function artifact(
    title: string,
    transcription: string,
    visibility: Visibility,
  ): Promise<number> {
    return createArtifact(harness.pool, {
      title,
      titleOriginal: '',
      language: 'ro',
      summary: '',
      visibility,
      noindex: false,
      provenance: '',
      repositoryName: 'Arhivele Naționale ale României',
      physicalLocation: '',
      dateCreated: '',
      creditLine: '',
      rightsStatement: '',
      transcription,
      transcriptionLanguage: 'ro',
    });
  }

  function titles(hits: readonly SearchHit[]): string[] {
    return hits.map((hit) => hit.title);
  }

  function snippetText(hit: SearchHit): string {
    return (hit.snippet?.segments ?? []).map((segment) => segment.text).join('');
  }

  describe('reach', () => {
    it('finds items of different kinds in one query', async () => {
      await essay('The Iasi Pogrom', 'A study of the pogrom.');
      await person('Mihai Pogrom-Adjacent', 'public');
      await artifact('Pogrom order', 'Text of the order.', 'public');

      const { hits, total } = await searchCorpus(harness.pool, viewer, 'pogrom');

      expect(total).toBe(3);
      expect(new Set(hits.map((hit) => hit.kind))).toEqual(
        new Set(['essay', 'person', 'artifact']),
      );
    });

    it('searches a biography, which the per-kind listing does not', async () => {
      await person('Elena Vasiliu', 'public', 'She worked as a telegraphist in Cernauti.');

      const { hits } = await searchCorpus(harness.pool, viewer, 'telegraphist');
      expect(titles(hits)).toEqual(['Elena Vasiliu']);
    });

    it('searches an essay body and an artifact transcription', async () => {
      await essay('Unrelated title', 'The word gendarmerie appears only here.');
      await artifact('Unrelated too', 'A transcription mentioning gendarmerie.', 'public');

      const { total } = await searchCorpus(harness.pool, viewer, 'gendarmerie');
      expect(total).toBe(2);
    });

    it('restricts to one kind when asked', async () => {
      await essay('Pogrom essay', 'Body.');
      await artifact('Pogrom artifact', '', 'public');

      const { hits } = await searchCorpus(harness.pool, viewer, 'pogrom', { kind: 'essay' });
      expect(titles(hits)).toEqual(['Pogrom essay']);
    });
  });

  describe('visibility', () => {
    // One case per kind: a union is exactly where a single unfiltered branch
    // would go unnoticed, because the other six still behave.
    it('hides a private item of every kind from an anonymous viewer', async () => {
      await essay('Private essay', 'Bucharest.', 'private');
      await person('Private person', 'private', 'Bucharest.');
      await artifact('Private artifact', 'Bucharest.', 'private');
      await createEntity(harness.pool, 'organization', {
        title: 'Private organization',
        titleOriginal: '',
        language: '',
        summary: 'Bucharest.',
        visibility: 'private',
        noindex: false,
        detail: {},
      });
      await createEntity(harness.pool, 'place', {
        title: 'Private place',
        titleOriginal: '',
        language: '',
        summary: 'Bucharest.',
        visibility: 'private',
        noindex: false,
        detail: {},
      });
      await createEntity(harness.pool, 'event', {
        title: 'Private event',
        titleOriginal: '',
        language: '',
        summary: 'Bucharest.',
        visibility: 'private',
        noindex: false,
        detail: {},
      });

      const asAdmin = await searchCorpus(harness.pool, viewer, 'bucharest');
      expect(asAdmin.total).toBe(6);

      const asAnyone = await searchCorpus(harness.pool, ANONYMOUS, 'bucharest');
      expect(asAnyone.total).toBe(0);
      expect(asAnyone.hits).toEqual([]);
    });

    it('returns a public item to an anonymous viewer', async () => {
      await essay('Public essay', 'Bucharest.', 'public');
      await essay('Private essay', 'Bucharest.', 'private');

      const { hits } = await searchCorpus(harness.pool, ANONYMOUS, 'bucharest');
      expect(titles(hits)).toEqual(['Public essay']);
    });
  });

  describe('snippets', () => {
    it('shows the text around the match', async () => {
      await essay(
        'Long essay',
        'An opening paragraph about nothing in particular. ' +
          'The gendarmerie arrived at dawn and sealed the street. ' +
          'A closing paragraph about nothing in particular.',
      );

      const { hits } = await searchCorpus(harness.pool, viewer, 'gendarmerie');
      const hit = hits[0];
      expect(hit).toBeDefined();
      expect(snippetText(hit!)).toContain('arrived at dawn');
      expect(hits[0]?.snippet?.segments.some((segment) => segment.match)).toBe(true);
    });

    it('returns segments rather than markup, so nothing is marked safe', async () => {
      await essay('Tag essay', 'A body mentioning AT&T and the gendarmerie.');

      const { hits } = await searchCorpus(harness.pool, viewer, 'gendarmerie');
      const segments = hits[0]?.snippet?.segments ?? [];
      expect(segments.length).toBeGreaterThan(0);
      // Raw text, carried through unescaped. Escaping is the template's job,
      // and it cannot be forgotten here because there is no markup to mark
      // safe in the first place -- only text and a boolean.
      expect(segments.some((segment) => segment.text.includes('AT&T'))).toBe(true);
      expect(segments.every((segment) => typeof segment.match === 'boolean')).toBe(true);
    });

    it('never puts a withheld reference into a snippet', async () => {
      await person('Maria Ionescu', 'private');
      await essay(
        'Public essay',
        'The witness [[person:maria-ionescu]] described the gendarmerie at dawn.',
      );

      const { hits } = await searchCorpus(harness.pool, ANONYMOUS, 'gendarmerie');
      const text = snippetText(hits[0]!);

      expect(text).toContain('gendarmerie');
      // Not the title, not the slug, and not the slug read as words.
      expect(text).not.toContain('Maria Ionescu');
      expect(text).not.toContain('maria-ionescu');
      expect(text.toLowerCase()).not.toContain('maria');
    });

    it('keeps the display text the prose itself used', async () => {
      await person('Maria Ionescu', 'private');
      await essay('Public essay', 'The witness [[person:maria-ionescu|a neighbour]] saw them.');

      const { hits } = await searchCorpus(harness.pool, ANONYMOUS, 'witness');
      const text = snippetText(hits[0]!);

      // The operator's own words, which the page already shows. What is
      // withheld is the catalogue record behind them.
      expect(text).toContain('a neighbour');
      expect(text).not.toContain('Ionescu');
    });

    it('shows a visible reference by title', async () => {
      await person('Ion Antonescu', 'public');
      await essay('Public essay', 'The order from [[person:ion-antonescu]] arrived at dawn.');

      const { hits } = await searchCorpus(harness.pool, ANONYMOUS, 'dawn');
      expect(snippetText(hits[0]!)).toContain('Ion Antonescu');
    });

    it('drops a citation marker rather than printing its locator', async () => {
      await essay('Public essay', 'The gendarmerie arrived.[[cite:hooligan-year|45-47]] Later.');

      const { hits } = await searchCorpus(harness.pool, viewer, 'gendarmerie');
      const text = snippetText(hits[0]!);
      expect(text).toContain('The gendarmerie arrived.');
      expect(text).not.toContain('45-47');
      expect(text).not.toContain('hooligan-year');
    });
  });

  describe('matching', () => {
    it('ignores accents in both directions', async () => {
      await essay('Iași in 1941', 'A study.');

      const plain = await searchCorpus(harness.pool, viewer, 'Iasi');
      expect(titles(plain.hits)).toEqual(['Iași in 1941']);

      await truncateContent(harness.pool);
      await essay('Iasi in 1941', 'A study.');
      const accented = await searchCorpus(harness.pool, viewer, 'Iași');
      expect(titles(accented.hits)).toEqual(['Iasi in 1941']);
    });

    it('highlights an accented match found by an unaccented query', async () => {
      await essay('A study', 'The train left Iași before dawn.');

      const { hits } = await searchCorpus(harness.pool, viewer, 'iasi');
      const matched = (hits[0]?.snippet?.segments ?? [])
        .filter((segment) => segment.match)
        .map((segment) => segment.text);

      // Folding is what makes this work: the row came back from an
      // accent-insensitive collation, so locating the term has to fold too or
      // the result is highlighted nowhere.
      expect(matched).toContain('Iași');
    });

    it('requires every word, in any order', async () => {
      await essay('The Iasi pogrom', 'A study of the events.');
      await essay('Pogrom elsewhere', 'Nothing about that city.');

      const both = await searchCorpus(harness.pool, viewer, 'pogrom iasi');
      expect(titles(both.hits)).toEqual(['The Iasi pogrom']);

      const reversed = await searchCorpus(harness.pool, viewer, 'iasi pogrom');
      expect(titles(reversed.hits)).toEqual(['The Iasi pogrom']);
    });

    it('matches words that live in different fields', async () => {
      await essay('The Iasi pogrom', 'The gendarmerie arrived at dawn.');

      const { hits } = await searchCorpus(harness.pool, viewer, 'iasi gendarmerie');
      expect(titles(hits)).toEqual(['The Iasi pogrom']);
    });

    it('treats LIKE wildcards as literal text', async () => {
      await essay('Ordinary essay', 'No wildcards here.');
      await essay('Discount 50% off', 'A body.');

      // Unescaped, "%" matches every row, which would quietly turn the search
      // box into a corpus dump.
      const wildcard = await searchCorpus(harness.pool, viewer, '%');
      expect(titles(wildcard.hits)).toEqual(['Discount 50% off']);

      const underscore = await searchCorpus(harness.pool, viewer, '_');
      expect(underscore.total).toBe(0);
    });

    it('returns nothing for an empty or whitespace query', async () => {
      await essay('Something', 'A body.');

      for (const query of ['', '   ', '\n\t']) {
        const { hits, total } = await searchCorpus(harness.pool, viewer, query);
        expect(total).toBe(0);
        expect(hits).toEqual([]);
      }
    });

    it('clamps a very long query', () => {
      const words = parseSearchQuery('a b c d e f g h i j k l');
      expect(words).toHaveLength(8);
      expect(parseSearchQuery(`${'x'.repeat(400)}`)[0]).toHaveLength(100);
    });
  });

  describe('ranking and paging', () => {
    it('puts a title match above a prose match', async () => {
      await essay('An unrelated title', 'The gendarmerie is mentioned only in the body.');
      await essay('The gendarmerie', 'An unrelated body.');

      const { hits } = await searchCorpus(harness.pool, viewer, 'gendarmerie');
      expect(titles(hits)).toEqual(['The gendarmerie', 'An unrelated title']);
      expect(hits[0]?.weight).toBe(3);
      expect(hits[1]?.weight).toBe(1);
    });

    it('pages without repeating or dropping a result', async () => {
      for (let index = 0; index < 7; index += 1) {
        await essay(`Pogrom study ${index}`, 'A body.');
      }

      const first = await searchCorpus(harness.pool, viewer, 'pogrom', { limit: 3, offset: 0 });
      const second = await searchCorpus(harness.pool, viewer, 'pogrom', { limit: 3, offset: 3 });
      const third = await searchCorpus(harness.pool, viewer, 'pogrom', { limit: 3, offset: 6 });

      expect(first.total).toBe(7);
      const seen = [...first.hits, ...second.hits, ...third.hits].map((hit) => hit.id);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });
  });

  describe('the page', () => {
    it('is behind the admin guard', async () => {
      const anonymous = await harness.app.inject({ method: 'GET', url: '/admin/search?q=pogrom' });
      expect(anonymous.statusCode).toBe(302);
      expect(anonymous.headers.location).toBe('/login');
    });

    it('renders results and highlights the match', async () => {
      await essay('The Iasi pogrom', 'The gendarmerie arrived at dawn.');

      const response = await getPage(harness, '/admin/search?q=gendarmerie', admin);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('The Iasi pogrom');
      expect(response.body).toContain('<mark>gendarmerie</mark>');
    });

    it('is never indexable, whatever the site setting', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/admin/search?q=pogrom',
        headers: { cookie: cookieHeader(admin) },
      });
      expect(response.headers['x-robots-tag']).toContain('noindex');
    });

    it('escapes a snippet rather than rendering markup from it', async () => {
      await essay('Tag essay', 'A body about AT&T and the gendarmerie.');

      const response = await getPage(harness, '/admin/search?q=gendarmerie', admin);
      expect(response.body).toContain('AT&amp;T');
      expect(response.body).not.toContain('AT&T ');
    });
  });
});
