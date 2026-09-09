/**
 * Inline references in prose.
 *
 * One syntax, two meanings:
 *
 *   [[person:ion-antonescu|Antonescu]]   a mention  -> link on the web, plain text in print
 *   [[place:iasi]]                       a mention  -> display defaults to the target's title
 *   [[cite:hooligan-year|45-47]]         a citation -> footnote on the web and in print
 *
 * The editor's sidebar picker writes these; they are never typed by hand,
 * though they remain readable and typeable on purpose. Keying them to the slug
 * rather than to a database id means the Markdown stays meaningful in any
 * other editor and survives a title being corrected.
 *
 * `mention` and `citation` rows are PROJECTIONS of this text, rebuilt on every
 * save. Nothing else writes them. That is what makes "everywhere this person
 * is mentioned" trustworthy -- the listing cannot drift from what the prose
 * actually says.
 */

/** Kinds a reference may target. `cite` is a source referenced as a citation. */
export const REFERENCE_KINDS = [
  'person',
  'organization',
  'place',
  'event',
  'artifact',
  'source',
  'essay',
  'manuscript',
  'cite',
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export function isReferenceKind(value: string): value is ReferenceKind {
  return (REFERENCE_KINDS as readonly string[]).includes(value);
}

/**
 * The reference pattern.
 *
 * The slug character class matches what `slugify` can produce, so a malformed
 * reference simply does not match and is left in the text as literal
 * characters rather than being half-interpreted. The display text excludes
 * `]` and newlines so a reference can never swallow the rest of a paragraph.
 */
export const REFERENCE_PATTERN =
  /\[\[([a-z_]{1,20}):([a-z0-9-]{1,190})(?:\|([^\]\n]{0,500}))?\]\]/g;

export interface ParsedReference {
  /** The kind as written, e.g. 'person' or 'cite'. */
  kind: ReferenceKind;
  /** The target's slug. For 'cite' this is a source's slug. */
  slug: string;
  /**
   * The pipe segment. For a mention this is the display text; for a citation
   * it is the locator ("45-47", "fond 12"). Undefined when omitted.
   */
  argument: string | undefined;
  /** The exact source text, so a replacement can be made verbatim. */
  raw: string;
  /** Character offset of `raw` in the source, for context extraction. */
  index: number;
}

/**
 * Extracts every well-formed reference, in document order.
 *
 * References with an unknown kind are skipped rather than reported: `[[a:b]]`
 * in prose about set notation is not an error, it is prose.
 */
export function parseReferences(markdown: string): ParsedReference[] {
  const found: ParsedReference[] = [];
  // The regex is module-level and stateful; a local clone avoids one call
  // leaking lastIndex into the next.
  const pattern = new RegExp(REFERENCE_PATTERN.source, 'g');

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const [raw, kind, slug, argument] = match;
    if (kind === undefined || slug === undefined || !isReferenceKind(kind)) continue;

    found.push({
      kind,
      slug,
      argument: argument === undefined || argument.trim() === '' ? undefined : argument.trim(),
      raw,
      index: match.index,
    });
  }

  return found;
}

/** Builds the canonical text form, which is what the picker inserts. */
export function formatReference(kind: ReferenceKind, slug: string, argument?: string): string {
  const trimmed = argument?.trim();
  // A display value containing ] or a newline would not parse back, so it is
  // dropped rather than written out to produce something unreadable.
  const safe =
    trimmed !== undefined && trimmed !== '' && !/[\]\n]/.test(trimmed) ? trimmed : undefined;
  return safe === undefined ? `[[${kind}:${slug}]]` : `[[${kind}:${slug}|${safe}]]`;
}

/**
 * The sentence a reference sits in, for backlink context.
 *
 * Sentence boundaries are approximated by looking for `.`, `!` or `?` followed
 * by whitespace. This is imperfect for abbreviations ("Dr. Ionescu") but the
 * result is only ever shown as context alongside a link, never used to make a
 * decision, so a slightly wide or narrow window costs nothing.
 */
export interface ContextOptions {
  /**
   * Resolved titles, keyed by `referenceKey`. Without it a reference that
   * carries no display text falls back to its slug, which reads badly.
   */
  titles?: ReadonlyMap<string, string> | undefined;
  maxLength?: number;
}

export function extractContext(
  markdown: string,
  reference: ParsedReference,
  options: ContextOptions = {},
): string {
  const maxLength = options.maxLength ?? 300;
  // Rewrite references to their display text FIRST, tracking where this one
  // lands. Looking for sentence boundaries in the raw Markdown does not work:
  // a sentence commonly ends `.[[cite:x|45]]`, where the full stop is not
  // followed by whitespace and so is invisible to a boundary search.
  let readable = '';
  let cursor = 0;
  let anchorStart = -1;
  let anchorLength = 0;

  const pattern = new RegExp(REFERENCE_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    readable += markdown.slice(cursor, match.index);

    const kind = match[1] ?? '';
    const slug = match[2] ?? '';

    // A citation is a footnote marker, not prose: its argument is a locator
    // ("45-47"), which would read as nonsense dropped into a sentence.
    const display = !isReferenceKind(kind)
      ? match[0]
      : kind === 'cite'
        ? ''
        : match[3] !== undefined && match[3].trim() !== ''
          ? match[3].trim()
          : (options.titles?.get(referenceKey(kind, slug)) ?? slug.replace(/-/g, ' '));

    if (match.index === reference.index) {
      anchorStart = readable.length;
      anchorLength = display.length;
    }

    readable += display;
    cursor = match.index + match[0].length;
  }
  readable += markdown.slice(cursor);

  if (anchorStart === -1) anchorStart = 0;

  // A sentence ends at .!? followed by space, or at a line break -- which also
  // stops a snippet from running back into a heading above it.
  const before = readable.slice(0, anchorStart);
  const boundary = /(?:[.!?]\s|\n)(?![\s\S]*(?:[.!?]\s|\n))/.exec(before);
  const start = boundary === null ? 0 : boundary.index + boundary[0].length;

  const afterIndex = anchorStart + anchorLength;
  const trailing = /[.!?](?:\s|$)|\n/.exec(readable.slice(afterIndex));
  const end = trailing === null ? readable.length : afterIndex + trailing.index + 1;

  const snippet = readable
    .slice(start, end)
    // Flatten the remaining inline Markdown so the snippet reads as prose.
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return snippet.length > maxLength ? `${snippet.slice(0, maxLength - 1).trimEnd()}…` : snippet;
}

/**
 * A reference resolved against the database, for the viewer asking.
 *
 * `visible: false` means the target exists but the viewer may not see it. The
 * renderer must then emit the display text as plain text and nothing else --
 * no href, no title, no id. That is invariant 2 in CLAUDE.md.
 */
export interface ResolvedReferenceTarget {
  id: number;
  kind: string;
  slug: string;
  title: string;
  visible: boolean;
}

/** Lookup key for a resolution map: the kind as written plus the slug. */
export function referenceKey(kind: ReferenceKind, slug: string): string {
  // 'cite' targets a source, so both spellings resolve to the same row and
  // must share a key.
  return `${kind === 'cite' ? 'source' : kind}:${slug}`;
}

/** The content_item.kind a reference kind targets. */
export function targetKind(kind: ReferenceKind): string {
  return kind === 'cite' ? 'source' : kind;
}

/**
 * URL path segment for each content kind.
 *
 * Written out rather than pluralised by appending "s", which would produce
 * "/persons/". This map is the single definition of a kind's public URL, used
 * by the renderer, by `resolveReference` and by the route registrations, so a
 * path cannot be spelled two different ways in two places.
 */
export const KIND_PATHS: Readonly<Record<string, string>> = Object.freeze({
  person: 'people',
  organization: 'organizations',
  place: 'places',
  event: 'events',
  artifact: 'artifacts',
  source: 'sources',
  essay: 'essays',
  manuscript: 'manuscripts',
});

/** The content kind a URL segment addresses, or null if it addresses none. */
export function kindForPath(path: string): string | null {
  const found = Object.entries(KIND_PATHS).find(([, segment]) => segment === path);
  return found?.[0] ?? null;
}

/** URL path for a resolved target. */
export function referenceHref(kind: string, slug: string): string {
  const segment = KIND_PATHS[kind] ?? kind;
  return `/${segment}/${encodeURIComponent(slug)}`;
}
