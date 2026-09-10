/**
 * Prose rendering and reference parsing.
 *
 * The security property under test: an essay body cannot introduce HTML, and a
 * reference to something the viewer may not see renders as plain text with no
 * href, title, slug or id.
 */
import { describe, expect, it } from 'vitest';
import {
  extractContext,
  formatReference,
  isReferenceKind,
  parseReferences,
  referenceKey,
  targetKind,
} from '../../src/content/references.js';
import {
  WITHHELD_LABEL,
  blockAnchorsFor,
  countWords,
  parseTimelineDirectives,
  renderFragment,
  renderProse,
  type ReferenceTarget,
} from '../../src/content/markdown.js';
import { timelineDirectiveKey, type TimelineEntry } from '../../src/content/timeline.js';
import { ANONYMOUS } from '../../src/content/visibility.js';
import type { CslItem } from '../../src/citations/csl.js';

const book: CslItem = {
  id: 'hooligan-year',
  type: 'book',
  title: 'The Hooligan Year',
  author: [{ family: 'Ionescu', given: 'Maria' }],
  publisher: 'Humanitas',
  issued: { 'date-parts': [[1998]] },
};

function targets(...entries: ReferenceTarget[]): Map<string, ReferenceTarget> {
  return new Map(
    entries.map((entry) => [
      referenceKey(entry.kind === 'source' ? 'source' : (entry.kind as 'person'), entry.slug),
      entry,
    ]),
  );
}

const antonescu: ReferenceTarget = {
  id: 1,
  kind: 'person',
  slug: 'ion-antonescu',
  title: 'Ion Antonescu',
  visible: true,
};

const hiddenPerson: ReferenceTarget = {
  ...antonescu,
  id: 2,
  slug: 'hidden-person',
  title: 'Hidden Person',
  visible: false,
};

const source: ReferenceTarget = {
  id: 3,
  kind: 'source',
  slug: 'hooligan-year',
  title: 'The Hooligan Year',
  visible: true,
  csl: book,
};

function render(markdown: string, map = targets(antonescu, hiddenPerson, source)) {
  return renderProse(markdown, { targets: map, viewer: ANONYMOUS });
}

describe('parseReferences', () => {
  it('finds mentions and citations in document order', () => {
    const found = parseReferences('A [[person:ion-antonescu|Antonescu]] and [[cite:x|45]].');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      kind: 'person',
      slug: 'ion-antonescu',
      argument: 'Antonescu',
    });
    expect(found[1]).toMatchObject({ kind: 'cite', slug: 'x', argument: '45' });
  });

  it('treats an omitted argument as undefined', () => {
    expect(parseReferences('[[place:iasi]]')[0]?.argument).toBeUndefined();
    expect(parseReferences('[[place:iasi|]]')[0]?.argument).toBeUndefined();
  });

  it('ignores an unknown kind rather than failing', () => {
    // `[[a:b]]` in prose about set notation is prose, not an error.
    expect(parseReferences('set [[a:b]] notation')).toHaveLength(0);
  });

  it('ignores malformed references', () => {
    for (const input of [
      '[[person:]]',
      '[[:slug]]',
      '[[person:Ion Antonescu]]',
      '[[person:UPPERCASE]]',
      '[person:x]',
      '[[person:x]',
      `[[person:x|line\nbreak]]`,
    ]) {
      expect(parseReferences(input), input).toHaveLength(0);
    }
  });

  it('does not let a reference swallow the rest of the paragraph', () => {
    const found = parseReferences('[[person:a|one]] then [[person:b|two]]');
    expect(found.map((entry) => entry.argument)).toEqual(['one', 'two']);
  });

  it('is not confused by repeated scans', () => {
    // The module-level pattern is stateful; each call must start fresh.
    const text = '[[person:a]] [[person:b]]';
    expect(parseReferences(text)).toHaveLength(2);
    expect(parseReferences(text)).toHaveLength(2);
  });

  it('round-trips through formatReference', () => {
    expect(formatReference('person', 'ion-antonescu', 'Antonescu')).toBe(
      '[[person:ion-antonescu|Antonescu]]',
    );
    expect(formatReference('place', 'iasi')).toBe('[[place:iasi]]');
    // A display value that could not parse back is dropped rather than written.
    expect(formatReference('person', 'x', 'has ] bracket')).toBe('[[person:x]]');
  });

  it('maps cite to the source kind', () => {
    expect(targetKind('cite')).toBe('source');
    expect(referenceKey('cite', 'x')).toBe(referenceKey('source', 'x'));
    expect(isReferenceKind('nonsense')).toBe(false);
  });
});

describe('extractContext', () => {
  it('returns the surrounding sentence with the reference read as prose', () => {
    const text =
      'An earlier sentence. The order was signed by [[person:ion-antonescu|Antonescu]] that spring. A later one.';
    const context = extractContext(text, parseReferences(text)[0]!);
    expect(context).toContain('The order was signed by Antonescu that spring');
    expect(context).not.toContain('[[');
    expect(context).not.toContain('A later one');
  });

  it('truncates a very long sentence', () => {
    const text = `${'word '.repeat(200)}[[person:ion-antonescu|A]] more`;
    expect(extractContext(text, parseReferences(text)[0]!).length).toBeLessThanOrEqual(300);
  });
});

describe('renderProse', () => {
  it('renders a visible mention as a link', () => {
    const { html } = render('Signed by [[person:ion-antonescu|Antonescu]].');
    expect(html).toContain('href="/people/ion-antonescu"');
    expect(html).toContain('>Antonescu</a>');
  });

  it('falls back to the target title when no display text is given', () => {
    const { html } = render('[[person:ion-antonescu]]');
    expect(html).toContain('>Ion Antonescu</a>');
  });

  it('renders a mention of a private item as plain text and leaks nothing', () => {
    const { html } = render('He met [[person:hidden-person|a colleague]] there.');
    expect(html).toContain('a colleague');
    // Invariant 2: no href, no title, no slug, no id.
    expect(html).not.toContain('hidden-person');
    expect(html).not.toContain('Hidden Person');
    expect(html).not.toContain('href');
  });

  it('marks an unresolved reference without emitting a dead link', () => {
    const { html } = render('[[person:deleted-person|Someone]]');
    expect(html).toContain('reference-broken');
    expect(html).toContain('Someone');
    expect(html).not.toContain('href');
  });

  it('renders a citation as a numbered footnote with the Chicago note', () => {
    const result = render('A claim.[[cite:hooligan-year|45]]');
    expect(result.html).toContain('href="#fn-1"');
    expect(result.footnotes).toHaveLength(1);
    expect(result.footnotes[0]?.html).toContain('The Hooligan Year');
    expect(result.footnotes[0]?.html).toContain('45');
  });

  it('numbers repeated citations and lists each source once in the bibliography', () => {
    const result = render('One.[[cite:hooligan-year|10]] Two.[[cite:hooligan-year|20]]');
    expect(result.footnotes.map((note) => note.number)).toEqual([1, 2]);
    expect(result.bibliography).toHaveLength(1);
  });

  it('withholds a citation to a source the viewer may not see', () => {
    const hidden: ReferenceTarget = { ...source, slug: 'secret-file', visible: false };
    const { html } = renderProse('Claim.[[cite:secret-file|3]]', {
      targets: targets(hidden),
      viewer: ANONYMOUS,
    });
    expect(html).toContain(WITHHELD_LABEL);
    expect(html).not.toContain('Hooligan');
    expect(html).not.toContain('secret-file');
  });

  it('escapes HTML in the body', () => {
    // `html: false` is the single most important setting in the renderer.
    const { html } = render('<script>alert(1)</script>\n\nText <img src=x onerror=alert(2)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML inside a reference display text', () => {
    const { html } = render('[[person:ion-antonescu|<script>alert(1)</script>]]');
    expect(html).not.toContain('<script>');
  });

  it('leaves a reference inside a code span literal', () => {
    // Structure-aware parsing is why this is an inline rule and not a
    // string substitution over the source.
    const { html } = render('Write `[[person:ion-antonescu]]` to link someone.');
    expect(html).toContain('[[person:ion-antonescu]]');
    expect(html).not.toContain('href=');
  });

  it('refuses to build a link from a javascript: URL', () => {
    // validateLink rejects it, so markdown-it leaves the source as literal
    // text: the string survives as inert prose, but no anchor is created.
    const { html } = render('[click](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
  });

  it('renders ordinary Markdown', () => {
    const { html } = render('# Heading\n\nSome *emphasis* and a [link](https://example.org).');
    // Top-level blocks carry a paragraph anchor; see the `block anchors`
    // suite below for what that is for.
    expect(html).toContain('<h1 id="p1">Heading</h1>');
    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('href="https://example.org"');
  });
});

describe('countWords', () => {
  it('counts a reference as its display text', () => {
    // The / order / was / signed / by / Antonescu / here
    expect(countWords('The order was signed by [[person:ion-antonescu|Antonescu]] here.')).toBe(7);
  });

  it('ignores Markdown punctuation', () => {
    expect(countWords('# A *bold* heading')).toBe(3);
  });

  it('is zero for empty prose', () => {
    expect(countWords('   \n\n  ')).toBe(0);
  });
});

describe('block anchors', () => {
  it('numbers top-level blocks so a backlink can address a paragraph', () => {
    const { html } = render('First paragraph.\n\n## A heading\n\nSecond paragraph.');
    expect(html).toContain('<p id="p1">');
    expect(html).toContain('<h2 id="p2">');
    expect(html).toContain('<p id="p3">');
  });

  it('does not number a fragment', () => {
    // renderProse and renderFragment share one renderer, and a page renders
    // several fragments: two of them carrying id="p1" would be invalid HTML
    // and an ambiguous anchor.
    expect(renderFragment('First.\n\nSecond.')).not.toContain('id="p');
  });

  it('does not number a block nested inside another', () => {
    const { html } = render('- one\n- two\n\nAfter.');
    expect(html).toContain('<ul id="p1">');
    // The list items are inside the list, which already counted.
    expect(html).not.toContain('<li id=');
    expect(html).toContain('<p id="p2">');
  });

  it('reports the block a reference falls in', () => {
    const markdown = 'First paragraph.\n\nNamed here: [[person:ion-antonescu]].\n\nLast.';
    const offsets = parseReferences(markdown).map((reference) => reference.index);
    expect(blockAnchorsFor(markdown, offsets)).toEqual([2]);
  });

  it('uses the same numbering the renderer emits', () => {
    // This is the property the whole feature rests on: a stored anchor has to
    // address a paragraph that actually exists in the rendered page.
    const markdown = '# Title\n\n> A quotation.\n\nProse with [[person:ion-antonescu]] in it.';
    const [anchor] = blockAnchorsFor(
      markdown,
      parseReferences(markdown).map((reference) => reference.index),
    );
    const { html } = render(markdown);
    expect(html).toContain(`<p id="p${anchor}">`);
  });

  it('maps every offset in a multi-reference body', () => {
    const markdown = '[[person:ion-antonescu]] opens.\n\nAnd [[person:hidden-person]] closes.';
    const offsets = parseReferences(markdown).map((reference) => reference.index);
    expect(blockAnchorsFor(markdown, offsets)).toEqual([1, 2]);
  });

  it('returns nothing for no offsets', () => {
    expect(blockAnchorsFor('Anything.', [])).toEqual([]);
  });
});

describe('timeline blocks', () => {
  const entry: TimelineEntry = {
    id: 7,
    slug: 'pogrom',
    title: 'The Iasi pogrom',
    href: '/events/pogrom',
    visibility: 'public',
    summary: null,
    dates: {
      startDate: '1941-06-29',
      endDate: null,
      startPrecision: 'day',
      endPrecision: 'unknown',
      isCirca: false,
    },
    dateLabel: '29 June 1941',
    place: null,
  };

  function withEntries(markdown: string, entries: TimelineEntry[]) {
    const directives = parseTimelineDirectives(markdown);
    const key = timelineDirectiveKey(directives[0]!);
    return renderProse(markdown, {
      targets: targets(),
      viewer: ANONYMOUS,
      timelines: new Map([[key, entries]]),
    }).html;
  }

  it('finds a directive through the tokenizer', () => {
    const directives = parseTimelineDirectives('```timeline\nfrom: 1940\n```');
    expect(directives).toHaveLength(1);
    expect(directives[0]?.from).toBe('1940-01-01');
  });

  it('does not read a fence inside an indented code block as a directive', () => {
    expect(parseTimelineDirectives('    ```timeline\n    from: 1940\n    ```')).toHaveLength(0);
  });

  it('renders the resolved entries as a list', () => {
    const html = withEntries('```timeline\nfrom: 1940\n```', [entry]);
    expect(html).toContain('class="timeline"');
    expect(html).toContain('29 June 1941');
    expect(html).toContain('href="/events/pogrom"');
  });

  it('escapes an entry title rather than trusting it', () => {
    const html = withEntries('```timeline\nfrom: 1940\n```', [
      { ...entry, title: '<script>alert(1)</script>' },
    ]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an empty chronology when nothing resolves, with no placeholder row', () => {
    const html = withEntries('```timeline\nfrom: 1940\n```', []);
    expect(html).toContain('No events to show here');
    // An event the viewer may not see must leave no trace at all -- not a gap,
    // not a "withheld" marker.
    expect(html).not.toContain('withheld');
  });

  it('renders with no resolution at all rather than throwing', () => {
    const html = renderProse('```timeline\n```', { targets: targets(), viewer: ANONYMOUS }).html;
    expect(html).toContain('class="timeline"');
  });

  it('leaves an ordinary fence alone', () => {
    const { html } = render('```sh\nnpm test\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('class="language-sh"');
    expect(html).toContain('npm test');
    expect(html).not.toContain('class="timeline"');
  });

  it('leaves a reference inside a code fence literal', () => {
    // The reason references are an inline rule rather than a substitution.
    const { html } = render('```\n[[person:ion-antonescu]]\n```');
    expect(html).toContain('[[person:ion-antonescu]]');
    expect(html).not.toContain('href="/people/ion-antonescu"');
  });
});
