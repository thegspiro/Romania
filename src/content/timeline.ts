/**
 * Chronology.
 *
 * Events already existed as a content kind with real DATE columns; what did
 * not exist was any way to read the material as a sequence. Everything
 * chronological lives here, for the same reason the public/private rule lives
 * in one file: a date that is formatted in two places eventually disagrees
 * with itself, and a listing whose ordering is written inline in five route
 * handlers cannot be reviewed.
 *
 * Two things this module is careful about.
 *
 * **Precision is not decoration.** `1944-01-01` stored at year precision means
 * "1944", not "1 January 1944". `formatEventDate` is the only place a stored
 * DATE becomes a human date, so nothing can render a certainty the record does
 * not carry. Templates print the string this module produced.
 *
 * **A timeline is a listing, which is the shape of thing that leaks.** Every
 * read here takes a `Viewer` and goes through `visibilityFilter`, including the
 * join to an event's place: a public event held at a private place shows no
 * place at all -- not its title, not its slug, not its id. A private event is
 * simply absent from a chronology, with no gap and no placeholder, exactly as a
 * private section is absent from a manuscript's contents.
 */
import type { RowDataPacket } from 'mysql2/promise';
import {
  limitOffsetClause,
  queryOne,
  queryRows,
  type Pool,
  type PoolConnection,
  type SqlParam,
} from '../db/pool.js';
import { referenceHref } from './references.js';
import { visibilityFilter, type Viewer, type Visibility } from './visibility.js';

export type DatePrecision = 'day' | 'month' | 'year' | 'decade' | 'unknown';

export const DATE_PRECISIONS: readonly DatePrecision[] = Object.freeze([
  'day',
  'month',
  'year',
  'decade',
  'unknown',
]);

export function isDatePrecision(value: unknown): value is DatePrecision {
  return typeof value === 'string' && (DATE_PRECISIONS as readonly string[]).includes(value);
}

/** Shown where an event carries no date at all. */
export const UNDATED_LABEL = 'Undated';

export interface EventDates {
  /** 'YYYY-MM-DD', as stored. */
  startDate: string | null;
  endDate: string | null;
  startPrecision: DatePrecision;
  endPrecision: DatePrecision;
  /** Approximate rather than imprecise: "c. 1943". Orthogonal to precision. */
  isCirca: boolean;
}

// --- Formatting ------------------------------------------------------------

const MONTHS: readonly string[] = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]);

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseIsoDate(value: string | null): DateParts | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return null;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/**
 * One endpoint, at the precision actually known.
 *
 * `unknown` renders the stored ISO date verbatim. That is the honest reading --
 * the record says this string and does not say how much of it is meaningful --
 * and it is also what every event page displayed before this module existed,
 * so a row that has not been re-edited since the upgrade reads exactly as it
 * did.
 */
function formatEndpoint(iso: string | null, precision: DatePrecision): string | null {
  const parts = parseIsoDate(iso);
  if (parts === null) return null;

  switch (precision) {
    case 'decade':
      return `${Math.floor(parts.year / 10) * 10}s`;
    case 'year':
      return String(parts.year);
    case 'month': {
      const month = MONTHS[parts.month - 1];
      return month === undefined ? String(parts.year) : `${month} ${parts.year}`;
    }
    case 'day': {
      const month = MONTHS[parts.month - 1];
      return month === undefined ? String(parts.year) : `${parts.day} ${month} ${parts.year}`;
    }
    case 'unknown':
      return iso;
  }
}

/** "c. June 1943 – 1945", "the 1940s" as "1940s", "Undated". */
export function formatEventDate(dates: EventDates): string {
  const start = formatEndpoint(dates.startDate, dates.startPrecision);
  const end = formatEndpoint(dates.endDate, dates.endPrecision);
  const circa = dates.isCirca ? 'c. ' : '';

  if (start === null && end === null) return UNDATED_LABEL;
  if (start === null) return `${circa}until ${end ?? ''}`.trimEnd();
  if (end === null || end === start) return `${circa}${start}`;
  // En dash: a date range, not a hyphenated compound.
  return `${circa}${start} – ${end}`;
}

/** The year a timeline places this event at, or null when it carries no date. */
export function eventYear(dates: EventDates): number | null {
  const parts = parseIsoDate(dates.startDate) ?? parseIsoDate(dates.endDate);
  return parts?.year ?? null;
}

/** The last year the event still runs through, for a span on the band. */
export function eventEndYear(dates: EventDates): number | null {
  const parts = parseIsoDate(dates.endDate) ?? parseIsoDate(dates.startDate);
  if (parts === null) return null;
  // A decade-precision endpoint runs to the end of its decade.
  const precision = dates.endDate === null ? dates.startPrecision : dates.endPrecision;
  return precision === 'decade' ? Math.floor(parts.year / 10) * 10 + 9 : parts.year;
}

// --- The timeline block directive ------------------------------------------

/**
 * A ```timeline block's parsed body.
 *
 * The keys are deliberately few. A directive that could express an arbitrary
 * query would be a query language embedded in prose, and the visibility rule
 * would then have to hold across whatever an author typed.
 */
export interface TimelineDirective {
  about: { kind: string; slug: string }[];
  from: string | null;
  to: string | null;
  limit: number;
  title: string | null;
}

export const TIMELINE_BLOCK_INFO = 'timeline';
const TIMELINE_DEFAULT_LIMIT = 25;
const TIMELINE_MAX_LIMIT = 100;

/** Kinds an `about:` entry may name -- the entity kinds an event connects to. */
const ABOUT_KINDS: readonly string[] = Object.freeze(['person', 'organization', 'place', 'event']);

/**
 * Parses the body of a timeline block.
 *
 * Unknown keys are ignored rather than reported, the same tolerance
 * `parseReferences` shows an unknown reference kind: prose that happens to
 * contain one is prose, not an error.
 */
export function parseTimelineDirective(body: string): TimelineDirective {
  const directive: TimelineDirective = {
    about: [],
    from: null,
    to: null,
    limit: TIMELINE_DEFAULT_LIMIT,
    title: null,
  };

  for (const line of body.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (value === '') continue;

    switch (key) {
      case 'about':
        for (const entry of value.split(',')) {
          const match = /^([a-z]{1,20}):([a-z0-9-]{1,190})$/.exec(entry.trim());
          if (match === null) continue;
          const [, kind, slug] = match;
          if (kind === undefined || slug === undefined) continue;
          if (!ABOUT_KINDS.includes(kind)) continue;
          directive.about.push({ kind, slug });
        }
        break;
      case 'from':
        directive.from = normaliseBoundary(value, 'start');
        break;
      case 'to':
        directive.to = normaliseBoundary(value, 'end');
        break;
      case 'limit': {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          directive.limit = Math.min(parsed, TIMELINE_MAX_LIMIT);
        }
        break;
      }
      case 'title':
        directive.title = value.slice(0, 200);
        break;
      default:
        break;
    }
  }

  return directive;
}

/**
 * A date boundary written as a year or as a full date.
 *
 * "1940" as a lower bound means 1 January 1940 and as an upper bound means
 * 31 December 1940, so `from: 1940` / `to: 1944` reads the way a historian
 * means it rather than stopping on new year's day.
 */
export function normaliseBoundary(value: string, edge: 'start' | 'end'): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}$/.test(trimmed)) return edge === 'start' ? `${trimmed}-01-01` : `${trimmed}-12-31`;
  return null;
}

/**
 * A stable identity for a directive, so identical blocks resolve once and a
 * rendered block can find the entries that were fetched for it.
 */
export function timelineDirectiveKey(directive: TimelineDirective): string {
  const about = directive.about.map((entry) => `${entry.kind}:${entry.slug}`).join(',');
  return [about, directive.from ?? '', directive.to ?? '', String(directive.limit)].join('|');
}

// --- Reads -----------------------------------------------------------------

export interface TimelineEntry {
  id: number;
  slug: string;
  title: string;
  href: string;
  visibility: Visibility;
  summary: string | null;
  dates: EventDates;
  /** Already formatted; templates print this rather than re-deciding. */
  dateLabel: string;
  /** Null when the event has no place OR the viewer may not see the one it has. */
  place: { title: string; href: string } | null;
}

const EVENT_COLUMNS = `
  ci.id, ci.slug, ci.title, ci.summary, ci.visibility,
  d.start_date, d.end_date, d.start_precision, d.end_precision, d.is_circa,
  place.slug AS place_slug, place.title AS place_title
`;

/**
 * The FROM clause every chronological read shares.
 *
 * The place is joined with the viewer's filter in the ON clause, not the WHERE
 * clause: a private place must make the *place* disappear, not the event. The
 * result is indistinguishable from an event that was never given a place,
 * which is the point -- an absence that reveals nothing.
 */
function eventSource(viewer: Viewer): { sql: string; params: SqlParam[] } {
  const placeVisible = visibilityFilter(viewer, 'place');
  return {
    sql: `FROM content_item ci
          JOIN event_detail d ON d.content_item_id = ci.id
          LEFT JOIN content_item place
            ON place.id = d.place_item_id AND ${placeVisible.sql}`,
    params: [...placeVisible.params],
  };
}

/**
 * Chronological ordering.
 *
 * Undated events sort last rather than at the beginning of time. On the same
 * day a coarser date sorts first, so "the 1940s" precedes "2 June 1940": the
 * wider claim contains the narrower one.
 */
const CHRONOLOGICAL_ORDER = `
  ORDER BY d.sort_date IS NULL ASC,
           d.sort_date ASC,
           FIELD(d.start_precision, 'decade', 'year', 'month', 'day') ASC,
           ci.title ASC,
           ci.id ASC
`;

interface EventRow extends RowDataPacket {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  visibility: Visibility;
  start_date: Date | string | null;
  end_date: Date | string | null;
  start_precision: DatePrecision;
  end_precision: DatePrecision;
  is_circa: number;
  place_slug: string | null;
  place_title: string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : String(value).slice(0, 10);
}

function toEntry(row: EventRow): TimelineEntry {
  const dates: EventDates = {
    startDate: isoOrNull(row.start_date),
    endDate: isoOrNull(row.end_date),
    startPrecision: row.start_precision,
    endPrecision: row.end_precision,
    isCirca: row.is_circa === 1,
  };

  return {
    id: Number(row.id),
    slug: String(row.slug),
    title: String(row.title),
    href: referenceHref('event', String(row.slug)),
    visibility: row.visibility,
    summary: row.summary,
    dates,
    dateLabel: formatEventDate(dates),
    // Null here means "no place to show", whether because there is none or
    // because the viewer may not see it. The template cannot tell them apart.
    place:
      row.place_slug === null || row.place_title === null
        ? null
        : { title: row.place_title, href: referenceHref('place', row.place_slug) },
  };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface TimelineFilters {
  search?: string | undefined;
  /** Year or ISO date; interpreted as an overlap with the event's span. */
  from?: string | undefined;
  to?: string | undefined;
  placeSlug?: string | undefined;
  /** Restrict to events connected to this item, by edge or by mention. */
  relatedKind?: string | undefined;
  relatedSlug?: string | undefined;
  limit?: number;
  offset?: number;
}

/** The whole chronology, filtered and paged. */
export async function listTimeline(
  db: Pool | PoolConnection,
  viewer: Viewer,
  filters: TimelineFilters = {},
): Promise<{ items: TimelineEntry[]; total: number }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const source = eventSource(viewer);
  const visible = visibilityFilter(viewer, 'ci');
  const conditions = ['ci.kind = ?', visible.sql];
  const params: SqlParam[] = [...source.params, 'event', ...visible.params];

  const search = filters.search?.trim();
  if (search !== undefined && search !== '') {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      `(ci.title LIKE ? ESCAPE '\\\\' OR ci.title_original LIKE ? ESCAPE '\\\\' ` +
        `OR ci.summary LIKE ? ESCAPE '\\\\')`,
    );
    params.push(pattern, pattern, pattern);
  }

  // Overlap, not containment: an event running 1941-1945 belongs in a
  // chronology of 1943 even though neither of its endpoints is in that year.
  const from = filters.from === undefined ? null : normaliseBoundary(filters.from, 'start');
  if (from !== null) {
    conditions.push('COALESCE(d.end_date, d.sort_date) >= ?');
    params.push(from);
  }

  const to = filters.to === undefined ? null : normaliseBoundary(filters.to, 'end');
  if (to !== null) {
    conditions.push('d.sort_date <= ?');
    params.push(to);
  }

  if (filters.placeSlug !== undefined && /^[a-z0-9-]{1,190}$/.test(filters.placeSlug)) {
    conditions.push('place.slug = ?');
    params.push(filters.placeSlug);
  }

  // Restricting to one subject's events resolves that subject under the
  // viewer's own filter first, so a private person's slug cannot be used to
  // ask which events touch them.
  if (filters.relatedSlug !== undefined && filters.relatedKind !== undefined) {
    const related = await findVisibleItem(db, filters.relatedKind, filters.relatedSlug, viewer);
    if (related === null) return { items: [], total: 0 };

    const ids = await relatedEventIds(db, related.id, viewer);
    if (ids.length === 0) return { items: [], total: 0 };

    conditions.push(`ci.id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const totalRow = await queryOne<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(*) AS total ${source.sql} ${where}`,
    params,
  );

  const rows = await queryRows<EventRow>(
    db,
    `SELECT ${EVENT_COLUMNS} ${source.sql} ${where}
     ${CHRONOLOGICAL_ORDER}
     ${limitOffsetClause(limit, offset)}`,
    params,
  );

  return { items: rows.map(toEntry), total: Number(totalRow?.total ?? 0) };
}

/**
 * One event's chronological view of itself, for its own page.
 *
 * Goes through the same source as every listing so the event page's date and
 * place are decided in exactly one place -- in particular the place, which is
 * withheld here by the same join that withholds it from a timeline.
 */
export async function findTimelineEntry(
  db: Pool | PoolConnection,
  slug: string,
  viewer: Viewer,
): Promise<TimelineEntry | null> {
  if (!/^[a-z0-9-]{1,190}$/.test(slug)) return null;

  const source = eventSource(viewer);
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<EventRow>(
    db,
    `SELECT ${EVENT_COLUMNS} ${source.sql}
      WHERE ci.kind = ? AND ci.slug = ? AND ${visible.sql}`,
    [...source.params, 'event', slug, ...visible.params],
  );

  return row === null ? null : toEntry(row);
}

/** Fetches events by id, re-applying the viewer's filter. */
async function listEventsByIds(
  db: Pool | PoolConnection,
  ids: readonly number[],
  viewer: Viewer,
  limit: number,
): Promise<TimelineEntry[]> {
  if (ids.length === 0) return [];

  const source = eventSource(viewer);
  const visible = visibilityFilter(viewer, 'ci');
  const placeholders = ids.map(() => '?').join(', ');

  const rows = await queryRows<EventRow>(
    db,
    `SELECT ${EVENT_COLUMNS} ${source.sql}
      WHERE ci.kind = ? AND ci.id IN (${placeholders}) AND ${visible.sql}
      ${CHRONOLOGICAL_ORDER}
      ${limitOffsetClause(Math.min(Math.max(limit, 1), 200))}`,
    [...source.params, 'event', ...ids, ...visible.params],
  );

  return rows.map(toEntry);
}

async function findVisibleItem(
  db: Pool | PoolConnection,
  kind: string,
  slug: string,
  viewer: Viewer,
): Promise<{ id: number; kind: string } | null> {
  if (!/^[a-z0-9-]{1,190}$/.test(slug) || !/^[a-z_]{1,20}$/.test(kind)) return null;

  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<RowDataPacket & { id: number; kind: string }>(
    db,
    `SELECT ci.id, ci.kind FROM content_item ci
      WHERE ci.kind = ? AND ci.slug = ? AND ${visible.sql}`,
    [kind, slug, ...visible.params],
  );

  return row === null ? null : { id: Number(row.id), kind: String(row.kind) };
}

/**
 * The ids of events connected to an item, by asserted edge or by prose.
 *
 * Filtered at every hop, the way `buildGraph` traverses: the edge itself, the
 * item we start from and the event we arrive at must all be visible. An event
 * reachable only through a private edge is not merely hidden from the list, it
 * is never reached -- otherwise the chronology would disclose that the edge
 * exists.
 */
async function relatedEventIds(
  db: Pool | PoolConnection,
  itemId: number,
  viewer: Viewer,
): Promise<number[]> {
  const edge = visibilityFilter(viewer, 'r');
  const near = visibilityFilter(viewer, 'ci');
  const far = visibilityFilter(viewer, 'other');

  const rows = await queryRows<RowDataPacket & { event_id: number }>(
    db,
    `SELECT r.to_item_id AS event_id
       FROM relationship r
       JOIN content_item ci ON ci.id = r.from_item_id
       JOIN content_item other ON other.id = r.to_item_id
      WHERE r.from_item_id = ? AND other.kind = ?
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}
      UNION
     SELECT r.from_item_id AS event_id
       FROM relationship r
       JOIN content_item ci ON ci.id = r.to_item_id
       JOIN content_item other ON other.id = r.from_item_id
      WHERE r.to_item_id = ? AND other.kind = ?
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}
      UNION
     SELECT m.to_item_id AS event_id
       FROM mention m
       JOIN content_item ci ON ci.id = m.from_item_id
       JOIN content_item other ON other.id = m.to_item_id
      WHERE m.from_item_id = ? AND other.kind = ?
        AND ${near.sql} AND ${far.sql}
      UNION
     SELECT m.from_item_id AS event_id
       FROM mention m
       JOIN content_item ci ON ci.id = m.to_item_id
       JOIN content_item other ON other.id = m.from_item_id
      WHERE m.to_item_id = ? AND other.kind = ?
        AND ${near.sql} AND ${far.sql}`,
    [
      itemId,
      'event',
      ...edge.params,
      ...near.params,
      ...far.params,
      itemId,
      'event',
      ...edge.params,
      ...near.params,
      ...far.params,
      itemId,
      'event',
      ...near.params,
      ...far.params,
      itemId,
      'event',
      ...near.params,
      ...far.params,
    ],
  );

  return rows.map((row) => Number(row.event_id));
}

/** The chronology panel for a person, organization, place or event page. */
export async function listEventsRelatedTo(
  db: Pool | PoolConnection,
  itemId: number,
  viewer: Viewer,
  limit = 50,
): Promise<TimelineEntry[]> {
  const ids = await relatedEventIds(db, itemId, viewer);
  // An event page must not list itself among its own connections.
  return listEventsByIds(
    db,
    ids.filter((id) => id !== itemId),
    viewer,
    limit,
  );
}

/** The chronology panel for an essay: the events its prose names, in order. */
export async function listEventsMentionedBy(
  db: Pool | PoolConnection,
  itemId: number,
  viewer: Viewer,
  limit = 50,
): Promise<TimelineEntry[]> {
  const near = visibilityFilter(viewer, 'ci');
  const far = visibilityFilter(viewer, 'other');

  const rows = await queryRows<RowDataPacket & { event_id: number }>(
    db,
    `SELECT DISTINCT m.to_item_id AS event_id
       FROM mention m
       JOIN content_item ci ON ci.id = m.from_item_id
       JOIN content_item other ON other.id = m.to_item_id
      WHERE m.from_item_id = ? AND other.kind = ? AND ${near.sql} AND ${far.sql}`,
    [itemId, 'event', ...near.params, ...far.params],
  );

  return listEventsByIds(
    db,
    rows.map((row) => Number(row.event_id)),
    viewer,
    limit,
  );
}

/**
 * Resolves every timeline block in a body to the entries it should show.
 *
 * Keyed by `timelineDirectiveKey`, so two identical blocks cost one query and
 * the renderer can find its entries without depending on document order.
 */
export async function resolveTimelineDirectives(
  db: Pool | PoolConnection,
  directives: readonly TimelineDirective[],
  viewer: Viewer,
): Promise<Map<string, TimelineEntry[]>> {
  const resolved = new Map<string, TimelineEntry[]>();

  for (const directive of directives) {
    const key = timelineDirectiveKey(directive);
    if (resolved.has(key)) continue;

    // `about:` naming several subjects means "events touching any of them",
    // which is the reading that makes a block about a person and a place
    // useful. Each subject is resolved under the viewer's filter, so an
    // unknown or invisible one contributes nothing rather than erroring.
    let entries: TimelineEntry[];
    if (directive.about.length === 0) {
      const result = await listTimeline(db, viewer, {
        from: directive.from ?? undefined,
        to: directive.to ?? undefined,
        limit: directive.limit,
      });
      entries = result.items;
    } else {
      const seen = new Map<number, TimelineEntry>();
      for (const subject of directive.about) {
        const result = await listTimeline(db, viewer, {
          from: directive.from ?? undefined,
          to: directive.to ?? undefined,
          relatedKind: subject.kind,
          relatedSlug: subject.slug,
          limit: directive.limit,
        });
        for (const entry of result.items) seen.set(entry.id, entry);
      }
      entries = sortEntries([...seen.values()]).slice(0, directive.limit);
    }

    resolved.set(key, entries);
  }

  return resolved;
}

/**
 * The same ordering as `CHRONOLOGICAL_ORDER`, in TypeScript.
 *
 * Needed only where entries from several queries are merged. Kept beside the
 * SQL so the two cannot be changed independently.
 */
export function sortEntries(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const precisionRank = (precision: DatePrecision): number =>
    ['decade', 'year', 'month', 'day', 'unknown'].indexOf(precision);

  return [...entries].sort((left, right) => {
    const leftKey = left.dates.startDate ?? left.dates.endDate;
    const rightKey = right.dates.startDate ?? right.dates.endDate;

    if (leftKey === null && rightKey !== null) return 1;
    if (leftKey !== null && rightKey === null) return -1;
    if (leftKey !== null && rightKey !== null && leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1;
    }

    const byPrecision =
      precisionRank(left.dates.startPrecision) - precisionRank(right.dates.startPrecision);
    if (byPrecision !== 0) return byPrecision;

    if (left.title !== right.title) return left.title < right.title ? -1 : 1;
    return left.id - right.id;
  });
}

// --- The visual band -------------------------------------------------------

export interface BandSpan {
  id: number;
  title: string;
  href: string;
  visibility: Visibility;
  dateLabel: string;
  startYear: number;
  endYear: number;
  /** Rounded to two decimals: SVG coordinates, in the band's user units. */
  x: number;
  width: number;
  y: number;
}

export interface BandTick {
  year: number;
  x: number;
}

export interface BandLayout {
  width: number;
  height: number;
  firstYear: number;
  lastYear: number;
  spans: BandSpan[];
  ticks: BandTick[];
  /** Events with no date at all: listed below, absent from the drawing. */
  undated: number;
}

const BAND_WIDTH = 960;
const BAND_ROW_HEIGHT = 22;
const BAND_AXIS_HEIGHT = 24;
const BAND_MIN_SPAN = 4;
const BAND_MAX_ROWS = 24;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Lays out a chronology as a band of spans.
 *
 * Pure and server-side: the band is rendered as SVG in the template, so it
 * needs no JavaScript, no vendored library and no CSP exception. The ordered
 * list beneath it is the same data, not a fallback.
 *
 * Returns null when nothing is dated, because an axis with no span on it is
 * a drawing that says nothing.
 */
export function layoutTimelineBand(entries: readonly TimelineEntry[]): BandLayout | null {
  const dated = entries.filter((entry) => eventYear(entry.dates) !== null);
  const undated = entries.length - dated.length;
  if (dated.length === 0) return null;

  const years = dated.map((entry) => eventYear(entry.dates) ?? 0);
  const endYears = dated.map((entry) => eventEndYear(entry.dates) ?? 0);
  const firstYear = Math.min(...years);
  const lastYear = Math.max(...endYears);
  // A single-year chronology still needs a non-zero span to divide by.
  const range = Math.max(lastYear - firstYear, 1);

  const scale = (year: number): number => ((year - firstYear) / range) * BAND_WIDTH;

  // Greedy row packing: a span goes in the first row whose last span ends
  // before it starts, so overlapping events stack instead of colliding.
  const rowEnds: number[] = [];
  const spans: BandSpan[] = [];

  for (const entry of sortEntries(dated)) {
    const startYear = eventYear(entry.dates) ?? firstYear;
    const endYear = Math.max(eventEndYear(entry.dates) ?? startYear, startYear);
    const x = scale(startYear);
    const width = Math.max(scale(endYear) - x, BAND_MIN_SPAN);

    let row = rowEnds.findIndex((end) => end <= x);
    if (row === -1) {
      if (rowEnds.length >= BAND_MAX_ROWS) row = rowEnds.length - 1;
      else {
        rowEnds.push(0);
        row = rowEnds.length - 1;
      }
    }
    rowEnds[row] = x + width + BAND_MIN_SPAN;

    spans.push({
      id: entry.id,
      title: entry.title,
      href: entry.href,
      visibility: entry.visibility,
      dateLabel: entry.dateLabel,
      startYear,
      endYear,
      x: round(x),
      width: round(width),
      y: row * BAND_ROW_HEIGHT,
    });
  }

  return {
    width: BAND_WIDTH,
    height: Math.max(rowEnds.length, 1) * BAND_ROW_HEIGHT + BAND_AXIS_HEIGHT,
    firstYear,
    lastYear,
    spans,
    ticks: axisTicks(firstYear, lastYear, scale),
    undated,
  };
}

/** Round-numbered years across the axis, at most a readable handful. */
function axisTicks(
  firstYear: number,
  lastYear: number,
  scale: (year: number) => number,
): BandTick[] {
  const range = Math.max(lastYear - firstYear, 1);
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
  const step = steps.find((candidate) => range / candidate <= 10) ?? 1000;

  const ticks: BandTick[] = [];
  const start = Math.ceil(firstYear / step) * step;
  for (let year = start; year <= lastYear; year += step) {
    ticks.push({ year, x: round(scale(year)) });
  }
  // A range narrower than one step would otherwise draw no tick at all.
  if (ticks.length === 0) ticks.push({ year: firstYear, x: 0 });
  return ticks;
}
