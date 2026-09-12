/**
 * Search across every kind at once.
 *
 * Each kind already has its own `?q=` listing. What this adds is the question
 * those cannot answer -- "where does this phrase appear anywhere in the
 * corpus?" -- which in year four is how a researcher finds a report again.
 *
 * It is a query, not an index and not a service. `db/migrations/0002` records
 * why there is no FULLTEXT index: `innodb_ft_min_token_size` silently drops
 * terms shorter than three characters, and the schema's `utf8mb4_0900_ai_ci`
 * collation already makes `LIKE` accent- and case-insensitive, so a search for
 * "Iasi" finds "Iași" and vice versa. Nothing here changes that decision; this
 * module only spans the kinds that decision left separate.
 *
 * Two properties matter more than speed:
 *
 *   - **Every branch applies `visibilityFilter`.** A union is exactly the
 *     shape where one forgotten branch leaks, so the branches are generated
 *     from one description of each kind rather than written out by hand.
 *   - **A snippet never says more than the viewer may see.** Prose contains
 *     `[[person:slug]]`, so a snippet cut from raw Markdown would print the
 *     slug of a private person on a results page. `readableProse` below
 *     rewrites every reference before any text is cut, and a reference the
 *     viewer may not follow contributes nothing at all -- not its title, not
 *     its slug. That is stricter than `renderProse`, deliberately: a page
 *     shows one item the viewer asked for, a search result set shows fragments
 *     of everything at once.
 */
import type { RowDataPacket } from 'mysql2/promise';
import {
  limitOffsetClause,
  queryOne,
  queryRows,
  type Pool,
  type PoolConnection,
} from '../db/pool.js';
import type { SqlParam } from '../db/pool.js';
import { isReferenceKind, parseReferences, REFERENCE_PATTERN, targetKind } from './references.js';
import { resolveTargets } from './mentions.js';
import { isAdmin, visibilityFilter, type Viewer, type Visibility } from './visibility.js';

export const SEARCH_KINDS = [
  'essay',
  'source',
  'artifact',
  'person',
  'organization',
  'place',
  'event',
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

export function isSearchKind(value: unknown): value is SearchKind {
  return typeof value === 'string' && (SEARCH_KINDS as readonly string[]).includes(value);
}

/** A run of snippet text, and whether it matched the query. */
export interface SearchSegment {
  text: string;
  match: boolean;
}

/**
 * Snippet text as **data, not markup**.
 *
 * The template wraps matched segments itself, so highlighting never requires
 * marking user-supplied text safe. Autoescaping stays on for every segment.
 */
export interface SearchSnippet {
  segments: SearchSegment[];
  /** Which field the snippet was cut from, for the label above it. */
  field: 'prose' | 'summary';
}

export interface SearchHit {
  id: number;
  kind: SearchKind;
  slug: string;
  title: string;
  visibility: Visibility;
  /** 3 = matched the title, 2 = matched catalogue metadata, 1 = matched prose. */
  weight: number;
  snippet: SearchSnippet | null;
  updatedAt: Date;
}

export interface SearchOptions {
  kind?: SearchKind | undefined;
  limit?: number;
  offset?: number;
}

export interface SearchResults {
  hits: SearchHit[];
  total: number;
  /** The words actually searched, after parsing and clamping. */
  words: string[];
}

/** Beyond this a query is user error, not a search; the extra words are dropped. */
const MAX_WORDS = 8;
const MAX_WORD_LENGTH = 100;
const SNIPPET_LENGTH = 260;

/**
 * Splits a raw query into the words that must all appear.
 *
 * Whitespace-separated, order-independent: "iasi pogrom" finds an essay whose
 * title says one and whose body says the other.
 */
export function parseSearchQuery(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => (word.length > MAX_WORD_LENGTH ? word.slice(0, MAX_WORD_LENGTH) : word))
    .slice(0, MAX_WORDS);
}

/**
 * Escapes a user-supplied LIKE pattern.
 *
 * Unescaped, a search for `%` matches every row. The same helper exists in the
 * per-kind repositories; it is repeated here rather than hoisted so that this
 * change set does not edit five modules it has no other reason to touch.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

interface KindSource {
  /** Restricts `content_item.kind`; several kinds share a detail table. */
  join: string;
  /** Weighted highest: what the item is called. */
  titleColumns: string[];
  /** Catalogue metadata -- the call number, the archive, the alternate names. */
  metaColumns: string[];
  /** Reference-bearing prose, if the kind has any. */
  proseColumn: string | null;
  /** Where a snippet's prose is read from, for the result page only. */
  prose: { table: string; column: string } | null;
}

const TITLE_COLUMNS = ['ci.title', 'ci.title_original'];

const SOURCES: Readonly<Record<SearchKind, KindSource>> = Object.freeze({
  essay: {
    join: 'LEFT JOIN essay_detail d ON d.content_item_id = ci.id',
    titleColumns: TITLE_COLUMNS,
    metaColumns: ['ci.summary'],
    proseColumn: 'd.body_markdown',
    prose: { table: 'essay_detail', column: 'body_markdown' },
  },
  source: {
    join: 'LEFT JOIN source_detail d ON d.content_item_id = ci.id',
    titleColumns: TITLE_COLUMNS,
    metaColumns: [
      'ci.summary',
      'd.container_title',
      'd.archive',
      'd.archive_location',
      'd.call_number',
      'd.notes',
    ],
    proseColumn: null,
    prose: null,
  },
  artifact: {
    join: 'LEFT JOIN artifact_detail d ON d.content_item_id = ci.id',
    titleColumns: TITLE_COLUMNS,
    metaColumns: [
      'ci.summary',
      'd.repository_name',
      'd.physical_location',
      'd.provenance',
      'd.credit_line',
    ],
    proseColumn: 'd.transcription',
    prose: { table: 'artifact_detail', column: 'transcription' },
  },
  person: {
    join: 'LEFT JOIN agent_detail d ON d.content_item_id = ci.id',
    titleColumns: TITLE_COLUMNS,
    metaColumns: ['ci.summary', 'd.alternate_names', 'd.occupation'],
    // The biography is prose whose references are projected like any other,
    // and until now nothing searched it: the per-kind listing looks at
    // alternate names and occupation only.
    proseColumn: 'd.biography',
    prose: { table: 'agent_detail', column: 'biography' },
  },
  organization: {
    join: 'LEFT JOIN agent_detail d ON d.content_item_id = ci.id',
    titleColumns: TITLE_COLUMNS,
    metaColumns: ['ci.summary', 'd.alternate_names', 'd.occupation'],
    proseColumn: 'd.biography',
    prose: { table: 'agent_detail', column: 'biography' },
  },
  place: {
    join: 'LEFT JOIN place_detail d ON d.content_item_id = ci.id',
    titleColumns: TITLE_COLUMNS,
    metaColumns: ['ci.summary', 'd.admin_area', 'd.historical_names'],
    proseColumn: null,
    prose: null,
  },
  event: {
    join: 'LEFT JOIN event_detail d ON d.content_item_id = ci.id',
    titleColumns: TITLE_COLUMNS,
    metaColumns: ['ci.summary'],
    proseColumn: 'd.body_markdown',
    prose: { table: 'event_detail', column: 'body_markdown' },
  },
});

/**
 * `word appears in any of these columns`, for every word.
 *
 * Only column names -- which are constants in this module -- and `?`
 * placeholders reach the SQL. Every value is bound.
 */
function allWordsIn(columns: readonly string[], words: readonly string[]): string {
  const anyColumn = `(${columns.map((column) => `${column} LIKE ? ESCAPE '\\\\'`).join(' OR ')})`;
  return words.map(() => anyColumn).join(' AND ');
}

function patternsFor(columns: readonly string[], words: readonly string[]): SqlParam[] {
  const params: SqlParam[] = [];
  for (const word of words) {
    const pattern = `%${escapeLike(word)}%`;
    for (const _column of columns) params.push(pattern);
  }
  return params;
}

interface Branch {
  sql: string;
  params: SqlParam[];
}

function branchFor(kind: SearchKind, viewer: Viewer, words: readonly string[]): Branch {
  const source = SOURCES[kind];
  const titled = source.titleColumns;
  const catalogued = [...source.titleColumns, ...source.metaColumns];
  const everything = source.proseColumn === null ? catalogued : [...catalogued, source.proseColumn];

  const visible = visibilityFilter(viewer, 'ci');

  // Parameter order follows the order the fragments appear in the statement:
  // the CASE in the SELECT list is bound before the WHERE clause.
  const params: SqlParam[] = [
    ...patternsFor(titled, words),
    ...patternsFor(catalogued, words),
    kind,
    ...visible.params,
    ...patternsFor(everything, words),
  ];

  const sql = `
    SELECT ci.id, ci.kind, ci.slug, ci.title, ci.summary, ci.visibility, ci.updated_at,
           CASE WHEN ${allWordsIn(titled, words)} THEN 3
                WHEN ${allWordsIn(catalogued, words)} THEN 2
                ELSE 1 END AS weight
      FROM content_item ci
      ${source.join}
     WHERE ci.kind = ? AND ${visible.sql} AND ${allWordsIn(everything, words)}`;

  return { sql, params };
}

interface HitRow extends RowDataPacket {
  id: number;
  kind: string;
  slug: string;
  title: string;
  summary: string | null;
  visibility: string;
  updated_at: Date;
  weight: number;
}

/**
 * Searches every kind the viewer may see.
 *
 * An empty query returns nothing rather than everything: a search box that
 * lists the whole corpus when submitted blank is a slow way to say "no query".
 */
export async function searchCorpus(
  db: Pool | PoolConnection,
  viewer: Viewer,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResults> {
  const words = parseSearchQuery(query);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  if (words.length === 0) {
    return { hits: [], total: 0, words };
  }

  const kinds: readonly SearchKind[] =
    options.kind === undefined ? SEARCH_KINDS : ([options.kind] as const);

  const branches = kinds.map((kind) => branchFor(kind, viewer, words));
  const union = branches.map((branch) => branch.sql).join('\n    UNION ALL\n');
  const params = branches.flatMap((branch) => branch.params);

  const totalRow = await queryOne<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(*) AS total FROM (${union}) AS hits`,
    params,
  );

  const rows = await queryRows<HitRow>(
    db,
    `SELECT * FROM (${union}) AS hits
      ORDER BY weight DESC, updated_at DESC, id ASC
      ${limitOffsetClause(limit, offset)}`,
    params,
  );

  const hits = await attachSnippets(db, viewer, rows, words);
  return { hits, total: Number(totalRow?.total ?? 0), words };
}

/**
 * Reads the prose behind one page of hits and cuts a snippet from each.
 *
 * Prose is fetched only for the rows being shown. Selecting a `MEDIUMTEXT`
 * column inside the union would materialise every matching body into the
 * temporary table before `LIMIT` ever applied.
 */
async function attachSnippets(
  db: Pool | PoolConnection,
  viewer: Viewer,
  rows: readonly HitRow[],
  words: readonly string[],
): Promise<SearchHit[]> {
  const prose = await readProse(db, rows);

  // One resolution for the whole page: every reference in every snippet
  // source, looked up together.
  const references = [...prose.values()].flatMap((text) => parseReferences(text));
  const targets = references.length === 0 ? new Map() : await resolveTargets(db, references);

  return rows.map((row) => {
    const kind = row.kind as SearchKind;
    const body = prose.get(Number(row.id));
    const source: { text: string; field: 'prose' | 'summary' } | null =
      body !== undefined && body.trim() !== ''
        ? { text: body, field: 'prose' }
        : row.summary !== null && row.summary.trim() !== ''
          ? { text: row.summary, field: 'summary' }
          : null;

    const snippet =
      source === null
        ? null
        : {
            segments: buildSegments(readableProse(source.text, viewer, targets), words),
            field: source.field,
          };

    return {
      id: Number(row.id),
      kind,
      slug: row.slug,
      title: row.title,
      visibility: row.visibility as Visibility,
      weight: Number(row.weight),
      snippet: snippet === null || snippet.segments.length === 0 ? null : snippet,
      updatedAt: row.updated_at,
    };
  });
}

async function readProse(
  db: Pool | PoolConnection,
  rows: readonly HitRow[],
): Promise<Map<number, string>> {
  const byTable = new Map<string, { column: string; ids: number[] }>();

  for (const row of rows) {
    const source = SOURCES[row.kind as SearchKind];
    if (source.prose === null) continue;
    const key = `${source.prose.table}.${source.prose.column}`;
    const existing = byTable.get(key);
    if (existing === undefined) {
      byTable.set(key, { column: source.prose.column, ids: [Number(row.id)] });
    } else {
      existing.ids.push(Number(row.id));
    }
  }

  const prose = new Map<number, string>();

  for (const [key, entry] of byTable) {
    const table = key.slice(0, key.indexOf('.'));
    const placeholders = entry.ids.map(() => '?').join(', ');
    const found = await queryRows<RowDataPacket & { content_item_id: number; text: string | null }>(
      db,
      // Table and column come from SOURCES, never from a request.
      `SELECT content_item_id, ${entry.column} AS text
         FROM ${table}
        WHERE content_item_id IN (${placeholders})`,
      entry.ids,
    );
    for (const row of found) {
      if (row.text !== null) prose.set(Number(row.content_item_id), row.text);
    }
  }

  return prose;
}

interface TargetRow {
  kind: string;
  slug: string;
  title: string;
  visibility: string;
}

/**
 * Turns prose into text that is safe to cut a snippet from.
 *
 * Every reference is replaced **before** any text is selected, so no later
 * step can accidentally carry `[[person:slug]]` into the output:
 *
 *   - a citation contributes nothing; it is a footnote marker, and its
 *     argument is a locator that reads as nonsense inside a sentence;
 *   - a mention with display text contributes that text -- the operator's own
 *     prose, which the page already shows;
 *   - a mention without display text contributes the target's title only when
 *     the viewer may see the target, and **nothing** otherwise.
 *
 * The last rule is the strict one. `renderProse` falls back to the slug in
 * that position; here there is no fallback, because a results page is a list
 * of fragments from across the corpus and a withheld name must not be
 * reconstructable from one of them.
 */
function readableProse(
  markdown: string,
  viewer: Viewer,
  targets: ReadonlyMap<string, TargetRow>,
): string {
  const pattern = new RegExp(REFERENCE_PATTERN.source, 'g');
  let readable = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    readable += markdown.slice(cursor, match.index);

    const kind = match[1] ?? '';
    const slug = match[2] ?? '';
    const argument = match[3];

    let display = '';
    if (!isReferenceKind(kind)) {
      // Not a reference at all, just text that looks like one.
      display = match[0];
    } else if (kind !== 'cite') {
      if (argument !== undefined && argument.trim() !== '') {
        display = argument.trim();
      } else {
        const target = targets.get(`${targetKind(kind)}:${slug}`);
        const visible = target !== undefined && (isAdmin(viewer) || target.visibility === 'public');
        display = visible ? target.title : '';
      }
    }

    readable += display;
    cursor = match.index + match[0].length;
  }

  readable += markdown.slice(cursor);

  // Flatten the remaining inline Markdown so a snippet reads as prose.
  return readable
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Case- and accent-folded text, with each folded character's position in the
 * original.
 *
 * MySQL matched accent-insensitively to produce these rows, so locating the
 * term for highlighting has to fold the same way -- otherwise a search for
 * "Iasi" returns the essay about Iași and then highlights nothing in it. The
 * map is what lets a match found in the folded text be cut from the original.
 */
function fold(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let index = 0;

  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const foldedCharacter = character.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const piece of foldedCharacter) {
      folded += piece;
      map.push(index);
    }
    index += character.length;
  }

  // Sentinel, so a match ending at the last character has an end offset.
  map.push(text.length);
  return { folded, map };
}

interface Span {
  start: number;
  end: number;
}

/**
 * Cuts a window around the first match and marks every match inside it.
 *
 * Returns segments rather than markup: the template decides what a match looks
 * like, and autoescaping applies to every piece of user text.
 */
function buildSegments(text: string, words: readonly string[]): SearchSegment[] {
  if (text === '') return [];

  const { folded, map } = fold(text);
  const spans: Span[] = [];

  for (const word of words) {
    const needle = fold(word).folded;
    if (needle === '') continue;
    let at = folded.indexOf(needle);
    while (at !== -1) {
      spans.push({ start: at, end: at + needle.length });
      at = folded.indexOf(needle, at + needle.length);
    }
  }

  spans.sort((left, right) => left.start - right.start);

  // No match in this field -- the hit came from the title or a metadata
  // column. The opening of the prose is still worth showing.
  const first = spans[0];
  const windowStart = first === undefined ? 0 : sentenceStart(folded, first.start);
  const windowEnd = Math.min(folded.length, windowStart + SNIPPET_LENGTH);

  const originalStart = map[windowStart] ?? 0;
  const originalEnd = map[windowEnd] ?? text.length;

  const segments: SearchSegment[] = [];
  let cursor = windowStart;

  for (const span of spans) {
    if (span.end <= cursor) continue;
    if (span.start >= windowEnd) break;
    const start = Math.max(span.start, cursor);
    const end = Math.min(span.end, windowEnd);
    if (end <= start) continue;
    if (start > cursor) {
      segments.push({ text: slice(text, map, cursor, start), match: false });
    }
    segments.push({ text: slice(text, map, start, end), match: true });
    cursor = end;
  }

  if (cursor < windowEnd) {
    segments.push({ text: slice(text, map, cursor, windowEnd), match: false });
  }

  if (segments.length === 0) return [];

  if (originalStart > 0) {
    const head = segments[0];
    if (head !== undefined && !head.match) head.text = `…${head.text.trimStart()}`;
    else segments.unshift({ text: '…', match: false });
  }
  if (originalEnd < text.length) {
    const tail = segments[segments.length - 1];
    if (tail !== undefined && !tail.match) tail.text = `${tail.text.trimEnd()}…`;
    else segments.push({ text: '…', match: false });
  }

  return segments;
}

function slice(text: string, map: readonly number[], from: number, to: number): string {
  return text.slice(map[from] ?? 0, map[to] ?? text.length);
}

/**
 * Walks back to the sentence or line the match sits in, so a snippet starts
 * somewhere a reader can parse rather than mid-word.
 */
function sentenceStart(folded: string, at: number): number {
  const lookBehind = 140;
  const from = Math.max(0, at - lookBehind);
  const before = folded.slice(from, at);
  const boundary = /(?:[.!?]\s|\n)(?![\s\S]*(?:[.!?]\s|\n))/.exec(before);
  if (boundary !== null) return from + boundary.index + boundary[0].length;
  if (from === 0) return 0;
  // No sentence boundary within reach: start at a word boundary instead.
  const space = before.indexOf(' ');
  return space === -1 ? from : from + space + 1;
}
