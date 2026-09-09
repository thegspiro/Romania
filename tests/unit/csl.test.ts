import { describe, expect, it } from 'vitest';
import {
  buildCslItem,
  creatorSummary,
  formatCreators,
  formatCslDate,
  isSourceType,
  issuedYear,
  parseCreators,
  parseCslDate,
  parseStoredCslItem,
  type SourceFormInput,
} from '../../src/citations/csl.js';

function form(overrides: Partial<SourceFormInput> = {}): SourceFormInput {
  return {
    id: 'test-source',
    cslType: 'book',
    title: 'A Title',
    authors: '',
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
    issued: '',
    accessed: '',
    archive: '',
    archiveLocation: '',
    callNumber: '',
    url: '',
    doi: '',
    isbn: '',
    language: '',
    note: '',
    ...overrides,
  };
}

describe('parseCreators', () => {
  it('splits "Family, Given"', () => {
    expect(parseCreators('Ionescu, Maria')).toEqual([{ family: 'Ionescu', given: 'Maria' }]);
  });

  it('treats a line without a comma as a literal name', () => {
    // Guessing which word is the surname is wrong often enough with Romanian,
    // Hungarian and institutional names that the code refuses to guess.
    expect(parseCreators('Ministerul de Interne')).toEqual([{ literal: 'Ministerul de Interne' }]);
  });

  it('reads one creator per line and ignores blanks', () => {
    expect(parseCreators('Ionescu, Maria\n\n  Popescu, Andrei  \n')).toEqual([
      { family: 'Ionescu', given: 'Maria' },
      { family: 'Popescu', given: 'Andrei' },
    ]);
  });

  it('handles a surname with no given name', () => {
    expect(parseCreators('Ionescu,')).toEqual([{ family: 'Ionescu' }]);
  });

  it('round-trips through formatCreators', () => {
    const text = 'Ionescu, Maria\nMinisterul de Interne';
    expect(formatCreators(parseCreators(text))).toBe(text);
  });
});

describe('creatorSummary', () => {
  it('joins one or two names', () => {
    expect(creatorSummary([{ family: 'Ionescu' }])).toBe('Ionescu');
    expect(creatorSummary([{ family: 'Ionescu' }, { family: 'Popescu' }])).toBe(
      'Ionescu and Popescu',
    );
  });

  it('abbreviates three or more', () => {
    expect(
      creatorSummary([{ family: 'Ionescu' }, { family: 'Popescu' }, { family: 'Smith' }]),
    ).toBe('Ionescu et al.');
  });

  it('is empty for no creators', () => {
    expect(creatorSummary(undefined)).toBe('');
    expect(creatorSummary([])).toBe('');
  });
});

describe('parseCslDate', () => {
  it('parses year, year-month and full dates', () => {
    expect(parseCslDate('1998')).toEqual({ 'date-parts': [[1998]] });
    expect(parseCslDate('1998-06')).toEqual({ 'date-parts': [[1998, 6]] });
    expect(parseCslDate('1943-06-14')).toEqual({ 'date-parts': [[1943, 6, 14]] });
  });

  it('keeps imprecise historical dates verbatim', () => {
    // Discarding "c. 1943" would lose information a historian deliberately
    // recorded.
    expect(parseCslDate('c. 1943')).toEqual({ literal: 'c. 1943' });
    expect(parseCslDate('n.d.')).toEqual({ literal: 'n.d.' });
    expect(parseCslDate('before March 1945')).toEqual({ literal: 'before March 1945' });
  });

  it('rejects impossible months and days as literals', () => {
    expect(parseCslDate('1998-13')).toEqual({ literal: '1998-13' });
    expect(parseCslDate('1998-06-45')).toEqual({ literal: '1998-06-45' });
  });

  it('is undefined for empty input', () => {
    expect(parseCslDate('')).toBeUndefined();
    expect(parseCslDate('   ')).toBeUndefined();
  });

  it('round-trips through formatCslDate', () => {
    for (const text of ['1998', '1998-06', '1943-06-14', 'c. 1943']) {
      expect(formatCslDate(parseCslDate(text))).toBe(text);
    }
  });
});

describe('buildCslItem', () => {
  it('omits empty fields rather than storing blanks', () => {
    // citeproc treats an empty string as present-but-blank and emits stray
    // punctuation for it.
    const item = buildCslItem(form());
    expect(item).toEqual({ id: 'test-source', type: 'book', title: 'A Title' });
  });

  it('maps form fields onto CSL names', () => {
    const item = buildCslItem(
      form({
        authors: 'Ionescu, Maria',
        containerTitle: 'Slavic Review',
        publisherPlace: 'Bucharest',
        issued: '1998',
        callNumber: 'ANR-12-45',
      }),
    );
    expect(item['container-title']).toBe('Slavic Review');
    expect(item['publisher-place']).toBe('Bucharest');
    expect(item['call-number']).toBe('ANR-12-45');
    expect(item.author).toEqual([{ family: 'Ionescu', given: 'Maria' }]);
    expect(issuedYear(item)).toBe(1998);
  });

  it('reports no year for a literal date', () => {
    expect(issuedYear(buildCslItem(form({ issued: 'n.d.' })))).toBeNull();
  });
});

describe('parseStoredCslItem', () => {
  it('accepts a JSON string or an object', () => {
    const raw = { id: 'x', type: 'book', title: 'T' };
    expect(parseStoredCslItem(JSON.stringify(raw))).toMatchObject(raw);
    expect(parseStoredCslItem(raw)).toMatchObject(raw);
  });

  it('preserves fields the application does not model', () => {
    // A Zotero import may carry extra CSL fields; dropping them on read and
    // writing back would quietly destroy the operator's data.
    const stored = { id: 'x', type: 'book', 'original-date': { 'date-parts': [[1930]] } };
    expect(parseStoredCslItem(stored)['original-date']).toEqual({ 'date-parts': [[1930]] });
  });

  it('rejects a record with no id or type', () => {
    expect(() => parseStoredCslItem({ title: 'T' })).toThrow();
  });
});

describe('isSourceType', () => {
  it('accepts known CSL types and rejects invented ones', () => {
    expect(isSourceType('article-journal')).toBe(true);
    expect(isSourceType('manuscript')).toBe(true);
    expect(isSourceType('not-a-type')).toBe(false);
    expect(isSourceType(42)).toBe(false);
  });
});
