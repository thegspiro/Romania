/**
 * Document assembly: the pure parts.
 *
 * Everything here is a function of text alone, so it is tested without a
 * database. The visibility half of assembly -- which sections a viewer gets --
 * lives in `tests/integration/manuscripts.test.ts`, because that is where it
 * actually happens.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SECTION_DEPTH,
  SECTION_ROLES,
  demoteHeadings,
  isSectionRole,
  referencesToPandoc,
  WITHHELD_IN_PANDOC,
  sectionAnchor,
} from '../../src/content/manuscripts.js';
import {
  BUILD_FORMATS,
  BUILD_MEDIA,
  isBuildAudience,
  isBuildFormat,
} from '../../src/content/builds.js';

describe('demoteHeadings', () => {
  it('leaves prose alone when there is nothing to demote', () => {
    expect(demoteHeadings('# Title\n\nBody.', 0)).toBe('# Title\n\nBody.');
    expect(demoteHeadings('# Title', -1)).toBe('# Title');
  });

  it('demotes a top-level heading by the section depth', () => {
    // A `#` inside a section nested two levels down becomes `###`, so the
    // compiled document has one heading hierarchy rather than several.
    expect(demoteHeadings('# Chapter\n\n## Part', 2)).toBe('### Chapter\n\n#### Part');
  });

  it('clamps at level 6 rather than emitting seven hashes', () => {
    // Markdown has no h7; `#######` would render as literal text in the PDF.
    expect(demoteHeadings('##### Deep', 5)).toBe('###### Deep');
    expect(demoteHeadings('###### Deeper', 3)).toBe('###### Deeper');
  });

  it('does not touch a hash inside a fenced code block', () => {
    const source = ['# Heading', '', '```sh', '# not a heading, a shell comment', '```', ''].join(
      '\n',
    );
    const demoted = demoteHeadings(source, 1);
    expect(demoted).toContain('## Heading');
    expect(demoted).toContain('# not a heading, a shell comment');
  });

  it('handles a tilde fence and a fence nested inside a backtick fence', () => {
    const source = [
      '~~~',
      '# inside tildes',
      '```',
      '# still inside',
      '~~~',
      '# real heading',
    ].join('\n');
    const demoted = demoteHeadings(source, 1);
    expect(demoted).toContain('# inside tildes');
    expect(demoted).toContain('# still inside');
    expect(demoted).toContain('## real heading');
  });

  it('ignores a hash that is not a heading', () => {
    // `#tag` has no space after the hash, so CommonMark does not treat it as a
    // heading and neither do we.
    expect(demoteHeadings('#tag and C# too', 2)).toBe('#tag and C# too');
  });
});

describe('referencesToPandoc', () => {
  const anchors = new Map([['essay:conclusion', sectionAnchor('essay', 'conclusion')]]);
  const titles = new Map([
    ['person:ion-antonescu', 'Ion Antonescu'],
    ['essay:conclusion', 'Conclusion'],
  ]);
  // Both maps arrive already filtered for the build's viewer; this function
  // makes no visibility decision of its own.
  const citable = new Set(['hooligan-year']);

  it('turns a citation with a locator into Pandoc citation syntax', () => {
    expect(
      referencesToPandoc('As argued.[[cite:hooligan-year|45-47]]', anchors, titles, citable),
    ).toBe('As argued.[@hooligan-year, 45-47]');
  });

  it('omits the locator when none was given', () => {
    expect(referencesToPandoc('[[cite:hooligan-year]]', anchors, titles, citable)).toBe(
      '[@hooligan-year]',
    );
  });

  it('renders a mention as plain text, using the resolved title when unlabelled', () => {
    expect(referencesToPandoc('[[person:ion-antonescu]] spoke.', anchors, titles, citable)).toBe(
      'Ion Antonescu spoke.',
    );
    expect(
      referencesToPandoc('[[person:ion-antonescu|the Marshal]]', anchors, titles, citable),
    ).toBe('the Marshal');
  });

  it('falls back to a readable slug when the reference resolved to nothing', () => {
    // A broken reference has no record behind it to protect, so the slug read
    // as words is the operator's own typing and better than "ion-antonescu"
    // in a finished PDF. A target that exists but is withheld is a different
    // case, and carries the marker instead -- see below.
    expect(referencesToPandoc('[[person:maria-ionescu]]', anchors, new Map(), citable)).toBe(
      'maria ionescu',
    );
  });

  it('never prints the title of a target the build may not show', () => {
    // assembleDocument puts the marker in the map for a withheld target, so
    // the catalogue title never reaches the document -- and neither does the
    // slug, which the fallback above would otherwise supply.
    const withheld = new Map([['person:maria-doe', WITHHELD_IN_PANDOC]]);
    const result = referencesToPandoc(
      'The witness [[person:maria-doe]] spoke.',
      anchors,
      withheld,
      citable,
    );
    expect(result).toBe(`The witness ${WITHHELD_IN_PANDOC} spoke.`);
    expect(result).not.toContain('Maria');
    expect(result).not.toContain('maria-doe');
  });

  it('keeps the words the prose used, even for a withheld target', () => {
    const withheld = new Map([['person:maria-doe', WITHHELD_IN_PANDOC]]);
    expect(
      referencesToPandoc('[[person:maria-doe|a neighbour]] spoke.', anchors, withheld, citable),
    ).toBe('a neighbour spoke.');
  });

  it('withholds a citation whose source is not in the bibliography', () => {
    // Emitting [@slug] for a source the viewer may not see would print the
    // private slug and leave Pandoc with a key pointing at nothing.
    const result = referencesToPandoc(
      'As argued.[[cite:secret-file|12]]',
      anchors,
      titles,
      citable,
    );
    expect(result).toBe(`As argued.${WITHHELD_IN_PANDOC}`);
    expect(result).not.toContain('secret-file');
    expect(result).not.toContain('@');
  });

  it('cross-references a mention whose target is also a section here', () => {
    expect(referencesToPandoc('See [[essay:conclusion]].', anchors, titles, citable)).toBe(
      'See [Conclusion](#sec-essay-conclusion).',
    );
  });

  it('leaves text with no references untouched', () => {
    expect(
      referencesToPandoc('Plain prose [with a link](http://x).', anchors, titles, citable),
    ).toBe('Plain prose [with a link](http://x).');
  });

  it('rewrites several references in one paragraph without losing the text between', () => {
    const result = referencesToPandoc(
      '[[person:ion-antonescu|He]] wrote to [[essay:conclusion]].[[cite:hooligan-year|12]]',
      anchors,
      titles,
      citable,
    );
    expect(result).toBe('He wrote to [Conclusion](#sec-essay-conclusion).[@hooligan-year, 12]');
  });
});

describe('sectionAnchor', () => {
  it('is stable and Pandoc-safe', () => {
    expect(sectionAnchor('essay', 'the-iasi-pogrom')).toBe('sec-essay-the-iasi-pogrom');
  });
});

describe('section and build vocabularies', () => {
  it('accepts only the four roles', () => {
    for (const role of SECTION_ROLES) expect(isSectionRole(role)).toBe(true);
    expect(isSectionRole('chapter')).toBe(false);
    expect(isSectionRole(undefined)).toBe(false);
    expect(isSectionRole(3)).toBe(false);
  });

  it('caps nesting depth', () => {
    expect(MAX_SECTION_DEPTH).toBe(5);
  });

  it('accepts only the known build formats and audiences', () => {
    for (const format of BUILD_FORMATS) expect(isBuildFormat(format)).toBe(true);
    expect(isBuildFormat('epub')).toBe(false);
    expect(isBuildAudience('admin')).toBe(true);
    expect(isBuildAudience('public')).toBe(true);
    expect(isBuildAudience('everyone')).toBe(false);
  });

  it('gives every format a media type', () => {
    for (const format of BUILD_FORMATS) {
      expect(BUILD_MEDIA[format].extension.length).toBeGreaterThan(0);
      expect(BUILD_MEDIA[format].mimeType).toContain('/');
    }
  });
});
