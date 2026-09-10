/**
 * Slug generation.
 *
 * The fixtures come from tests/fixtures/slug-cases.json, which
 * worker/tests/test_bibliography_import.py reads too. The Python worker has
 * its own slugify because it creates sources during a bibliography import, and
 * the two must agree exactly -- otherwise the same title imported one way and
 * typed the other produces two different URLs.
 *
 * The list used to be duplicated in both files with a comment asking whoever
 * edited one to remember the other. Reading one file instead means a change to
 * the cases is a change to both suites at once, which is the only version of
 * that promise a machine can keep.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_SLUG_LENGTH, slugify, uniqueSlug } from '../../src/content/slug.js';

// Read rather than imported: a JSON import needs resolveJsonModule plus import
// attributes under NodeNext, which is more machinery than one readFileSync.
const fixturesPath = new URL('../fixtures/slug-cases.json', import.meta.url);
const parsed = JSON.parse(readFileSync(fixturesPath, 'utf8')) as { cases: [string, string][] };

export const SHARED_FIXTURES: [string, string][] = parsed.cases;

describe('slugify', () => {
  it.each(SHARED_FIXTURES)('turns %j into %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('transliterates both Romanian comma-below and cedilla forms alike', () => {
    // Documents and PDF extractions use these interchangeably; they must not
    // produce two different slugs for the same place.
    expect(slugify('București')).toBe(slugify('Bucureşti'));
    expect(slugify('Sfântu Gheorghe')).toBe('sfantu-gheorghe');
  });

  it('collapses punctuation and trims separators', () => {
    expect(slugify('  ...Hello --- World!!!  ')).toBe('hello-world');
  });

  it('returns an empty string when nothing is sluggable', () => {
    // The caller must handle this rather than creating an item with no address.
    expect(slugify('!!!')).toBe('');
    expect(slugify('')).toBe('');
  });

  it('truncates without leaving a trailing separator', () => {
    const slug = slugify(`${'word '.repeat(80)}`);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when it is free', async () => {
    expect(await uniqueSlug('The Hooligan Year', () => Promise.resolve(false))).toBe(
      'the-hooligan-year',
    );
  });

  it('appends a counter until it finds a free slug', async () => {
    const taken = new Set(['report', 'report-2', 'report-3']);
    expect(await uniqueSlug('Report', (candidate) => Promise.resolve(taken.has(candidate)))).toBe(
      'report-4',
    );
  });

  it('falls back when the title yields no slug', async () => {
    expect(await uniqueSlug('!!!', () => Promise.resolve(false), 'source')).toBe('source');
  });

  it('keeps the suffixed slug within the column length', async () => {
    const long = 'a'.repeat(300);
    const slug = await uniqueSlug(long, (candidate) =>
      Promise.resolve(candidate === 'a'.repeat(MAX_SLUG_LENGTH)),
    );
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-2')).toBe(true);
  });
});
