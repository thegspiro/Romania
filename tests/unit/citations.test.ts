/**
 * Citation rendering.
 *
 * The expected strings below are the contract with the reader: they are what
 * appears on a public page and what a reader will paste into their own notes.
 * When a CSL style update changes one of them, that means every citation on
 * the site changed -- review the diff rather than updating the expectation on
 * autopilot.
 */
import { describe, expect, it } from 'vitest';
import {
  renderBibliography,
  renderBibliographyEntry,
  renderNote,
  sanitizeCitationHtml,
} from '../../src/citations/render.js';
import type { CslItem } from '../../src/citations/csl.js';

const book: CslItem = {
  id: 'hooligan-year',
  type: 'book',
  title: 'The Hooligan Year',
  author: [{ family: 'Ionescu', given: 'Maria' }],
  publisher: 'Humanitas',
  'publisher-place': 'Bucharest',
  issued: { 'date-parts': [[1998]] },
};

const journalArticle: CslItem = {
  id: 'peasant-revolt',
  type: 'article-journal',
  title: 'Peasant Revolt and the State',
  author: [
    { family: 'Popescu', given: 'Andrei' },
    { family: 'Smith', given: 'John R.' },
  ],
  'container-title': 'Slavic Review',
  volume: '57',
  issue: '3',
  page: '512-534',
  issued: { 'date-parts': [[1998]] },
};

const archivalDocument: CslItem = {
  id: 'iasi-report',
  type: 'manuscript',
  title: 'Raport asupra Comisiei de la Iași',
  author: [{ literal: 'Ministerul de Interne' }],
  archive: 'Arhivele Naționale ale României',
  archive_location: 'fond 12, dosar 45',
  issued: { 'date-parts': [[1943, 6, 14]] },
};

describe('Chicago notes-bibliography rendering', () => {
  it('renders a book bibliography entry', () => {
    expect(renderBibliographyEntry(book)).toBe(
      'Ionescu, Maria. <i>The Hooligan Year</i>. Humanitas, 1998.',
    );
  });

  it('renders a book footnote', () => {
    expect(renderNote(book)).toBe('Maria Ionescu, <i>The Hooligan Year</i> (Humanitas, 1998).');
  });

  it('includes a page locator in the footnote', () => {
    expect(renderNote(book, { locator: '45', label: 'page' })).toBe(
      'Maria Ionescu, <i>The Hooligan Year</i> (Humanitas, 1998), 45.',
    );
  });

  it('renders two authors joined per Chicago', () => {
    expect(renderBibliographyEntry(journalArticle)).toBe(
      'Popescu, Andrei, and John R. Smith. “Peasant Revolt and the State.” ' +
        '<i>Slavic Review</i> 57, no. 3 (1998): 512–34.',
    );
  });

  it('renders an archival document with its fond and repository', () => {
    const entry = renderBibliographyEntry(archivalDocument);
    expect(entry).toContain('Ministerul de Interne');
    expect(entry).toContain('Fond 12, dosar 45');
    expect(entry).toContain('Arhivele Naționale ale României');
    expect(entry).toContain('June 14, 1943');
  });

  it('preserves Romanian diacritics', () => {
    expect(renderBibliographyEntry(archivalDocument)).toContain('Iași');
  });

  it('renders a corporate author without inverting it into a surname', () => {
    // A literal name must not be split; "Interne, Ministerul de" would be wrong.
    expect(renderNote(archivalDocument)).toContain('Ministerul de Interne,');
  });

  it('sorts a multi-item bibliography by the style rules', () => {
    const entries = renderBibliography([journalArticle, book]);
    expect(entries).toHaveLength(2);
    // Ionescu sorts before Popescu.
    expect(entries[0]).toContain('Ionescu');
    expect(entries[1]).toContain('Popescu');
  });

  it('does not leak state between renders on the shared engine', () => {
    // A processor that registered citations would render the second call as
    // "Ibid." instead of the full note.
    const first = renderNote(book);
    renderNote(journalArticle);
    expect(renderNote(book)).toBe(first);
  });
});

describe('citation HTML sanitising', () => {
  it('keeps the inline markup CSL allows', () => {
    expect(sanitizeCitationHtml('<i>Title</i> and <b>bold</b>')).toBe(
      '<i>Title</i> and <b>bold</b>',
    );
  });

  it('escapes a tag carrying attributes', () => {
    expect(sanitizeCitationHtml('<b onmouseover="alert(1)">x</b>')).toBe(
      '&lt;b onmouseover=&quot;alert(1)&quot;&gt;x</b>',
    );
  });

  it('escapes tags outside the allowlist', () => {
    expect(sanitizeCitationHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(sanitizeCitationHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('leaves entities citeproc already emitted alone', () => {
    // Re-escaping would show the reader a literal "&amp;#60;".
    expect(sanitizeCitationHtml('&#60;script&#62; &amp; more')).toBe('&#60;script&#62; &amp; more');
  });

  it('neutralises hostile bibliographic data end to end', () => {
    // A Zotero import is untrusted input: it reaches this code as CSL fields.
    const hostile: CslItem = {
      id: 'hostile',
      type: 'book',
      title: '<script>alert(1)</script>',
      author: [{ family: '<img src=x onerror=alert(2)>', given: 'A' }],
      publisher: '<b onmouseover="alert(3)">Press</b>',
      issued: { 'date-parts': [[2001]] },
    };

    const rendered = renderBibliographyEntry(hostile);

    // The hostile text survives as *visible text* -- "onerror=alert(2)" is
    // displayed to the reader, which is correct: the operator should see what
    // the import actually contained. What must not survive is a live tag.
    expect(rendered).toContain('&#60;img src=x onerror=alert(2)&#62;');

    // The precise property: after removing the tags CSL is allowed to emit,
    // no unescaped "<" remains anywhere, so nothing can open an element.
    const withoutAllowedTags = rendered.replace(/<\/?(?:i|b|sup|sub)>/g, '');
    expect(withoutAllowedTags).not.toContain('<');
  });
});
