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
  execute,
  limitOffsetClause,
  queryOne,
  queryRows,
  withTransaction,
  type Pool,
  type PoolConnection,
  type SqlParam,
} from '../db/pool.js';
import { referenceHref } from './references.js';
import { visibilityFilter, type Viewer, type Visibility } from './visibility.js';

/**
 * How much of a stored instant is actually meant.
 *
 * One ladder, coarse to fine, covering the clock as well as the calendar: an
 * order signed at 14:30 and a war lasting six years are both events. The
 * stored value is read only as far as the precision claims -- 1944-01-01 at
 * 'year' is "1944", 14:00 at 'hour' is "the 14:00 hour" -- and a time is not
 * shown at all below 'hour', however the column happens to be filled.
 *
 * Deliberately not shared with `relationships.ts`, whose own ladder stops at
 * 'day': a period on an edge is a span of days, and an office does not begin
 * at 14:30. Two vocabularies, not two copies of one.
 */
export type DatePrecision = 'decade' | 'year' | 'month' | 'day' | 'hour' | 'minute' | 'unknown';

/** Coarse to fine. `unknown` is last: it is not a rung, it is the absence. */
export const DATE_PRECISIONS: readonly DatePrecision[] = Object.freeze([
  'decade',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'unknown',
]);

/** Precisions that claim a time of day. Below these the clock is not shown. */
const TIMED_PRECISIONS: readonly DatePrecision[] = Object.freeze(['hour', 'minute']);

export function isDatePrecision(value: unknown): value is DatePrecision {
  return typeof value === 'string' && (DATE_PRECISIONS as readonly string[]).includes(value);
}

/** Shown where an event carries no date at all. */
export const UNDATED_LABEL = 'Undated';

export interface EventDates {
  /** 'YYYY-MM-DD', as stored. */
  startDate: string | null;
  endDate: string | null;
  /** 'HH:MM', as stored. Shown only when the precision reaches it. */
  startTime: string | null;
  endTime: string | null;
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
function formatEndpoint(
  iso: string | null,
  time: string | null,
  precision: DatePrecision,
): string | null {
  const parts = parseIsoDate(iso);
  if (parts === null) return null;

  const day = (): string => {
    const month = MONTHS[parts.month - 1];
    return month === undefined ? String(parts.year) : `${parts.day} ${month} ${parts.year}`;
  };

  switch (precision) {
    case 'decade':
      return `${Math.floor(parts.year / 10) * 10}s`;
    case 'year':
      return String(parts.year);
    case 'month': {
      const month = MONTHS[parts.month - 1];
      return month === undefined ? String(parts.year) : `${month} ${parts.year}`;
    }
    case 'day':
      return day();
    case 'hour':
    case 'minute': {
      // Truncated to the rung claimed, the same rule the date follows: at
      // 'hour', 14:37 in the column reads as 14:00, meaning the 14:00 hour.
      const clock = formatClock(time, precision);
      return clock === null ? day() : `${day()}, ${clock}`;
    }
    case 'unknown':
      return iso;
  }
}

/** 'HH:MM' or 'HH:MM:SS' from the column, truncated to the precision claimed. */
function formatClock(value: string | null, precision: DatePrecision): string | null {
  if (value === null) return null;
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (match === null) return null;
  const [, hour, minute] = match;
  if (hour === undefined || minute === undefined) return null;
  return precision === 'minute' ? `${hour}:${minute}` : `${hour}:00`;
}

/** True when this precision claims a time of day at all. */
export function claimsTime(precision: DatePrecision): boolean {
  return TIMED_PRECISIONS.includes(precision);
}

/** "c. June 1943 – 1945", "2 June 1943, 14:30", "1940s", "Undated". */
export function formatEventDate(dates: EventDates): string {
  const start = formatEndpoint(dates.startDate, dates.startTime, dates.startPrecision);
  const end = formatEndpoint(dates.endDate, dates.endTime, dates.endPrecision);
  const circa = dates.isCirca ? 'c. ' : '';

  if (start === null && end === null) return UNDATED_LABEL;
  if (start === null) return `${circa}until ${end ?? ''}`.trimEnd();
  if (end === null || end === start) return `${circa}${start}`;
  // En dash: a date range, not a hyphenated compound.
  return `${circa}${start} – ${end}`;
}

// --- Relative dating -------------------------------------------------------

/**
 * The predicate that records "this happened after that".
 *
 * One predicate read in both directions: an edge X -> A says X is after A, and
 * the same row read from A says A is before X. Two predicates would let one
 * fact be asserted twice and disagree with itself.
 */
export const BOUND_PREDICATE = 'happened_after';

/** One end of a relative bound: an event this one is known to sit beside. */
export interface EventBoundAnchor {
  id: number;
  title: string;
  href: string;
  /** The anchor's own date label, when it has one. */
  dateLabel: string | null;
}

/**
 * Where an event sits when nothing dates it directly.
 *
 * Every anchor here survived the viewer's filter, on the edge and on the
 * anchor event alike. That is not only about hiding a row: the derived window
 * is computed from these anchors, so an anchor the viewer may not see must be
 * dropped *before* the arithmetic, or the position on the band would disclose
 * a private event's date without ever naming it.
 */
export interface EventBounds {
  after: EventBoundAnchor[];
  before: EventBoundAnchor[];
  /** The tightest window the visible anchors support, as ISO dates. */
  earliest: string | null;
  latest: string | null;
}

/** "after the Iași pogrom, before the armistice". */
export function formatEventBounds(bounds: EventBounds): string | null {
  const after = bounds.after[0];
  const before = bounds.before[0];

  const parts: string[] = [];
  if (after !== undefined) parts.push(`after ${after.title}`);
  if (before !== undefined) parts.push(`before ${before.title}`);
  return parts.length === 0 ? null : parts.join(', ');
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
  /**
   * Where the event sits when nothing dates it directly. Null when it carries
   * its own date, or when no visible bound places it.
   */
  bounds: EventBounds | null;
}

const EVENT_COLUMNS = `
  ci.id, ci.slug, ci.title, ci.summary, ci.visibility,
  d.start_date, d.end_date, d.start_time, d.end_time,
  d.start_precision, d.end_precision, d.is_circa,
  place.slug AS place_slug, place.title AS place_title,
  lower_bound.earliest AS bound_earliest,
  upper_bound.latest AS bound_latest
`;

/**
 * The FROM clause every chronological read shares.
 *
 * Two things happen here that the WHERE clause must not do.
 *
 * The **place** is joined with the viewer's filter in the ON clause, not the
 * WHERE clause: a private place must make the *place* disappear, not the
 * event. The result is indistinguishable from an event that was never given a
 * place, which is the point -- an absence that reveals nothing.
 *
 * The **relative bounds** are aggregated in derived tables so an event with no
 * date of its own still has somewhere to sort. Each carries the filter twice,
 * on the edge and on the anchor event: an anchor the viewer may not see is
 * dropped before the MIN/MAX, never after. Filtering afterwards would leave
 * the private anchor's date deciding where a public event sits on the band,
 * which discloses it just as surely as printing its title would.
 *
 * Only direct anchors count. An anchor that is itself undated contributes
 * nothing rather than being chased through a chain of guesses.
 */
function eventSource(viewer: Viewer): { sql: string; params: SqlParam[] } {
  const placeVisible = visibilityFilter(viewer, 'place');
  const lowerEdge = visibilityFilter(viewer, 'lr');
  const lowerAnchor = visibilityFilter(viewer, 'la');
  const upperEdge = visibilityFilter(viewer, 'ur');
  const upperAnchor = visibilityFilter(viewer, 'ua');

  return {
    sql: `FROM content_item ci
          JOIN event_detail d ON d.content_item_id = ci.id
          LEFT JOIN content_item place
            ON place.id = d.place_item_id AND ${placeVisible.sql}
          LEFT JOIN (
            SELECT lr.from_item_id AS event_id,
                   MAX(COALESCE(lad.end_date, lad.sort_date)) AS earliest
              FROM relationship lr
              JOIN relationship_predicate lp
                ON lp.id = lr.predicate_id AND lp.code = ?
              JOIN content_item la ON la.id = lr.to_item_id
              JOIN event_detail lad ON lad.content_item_id = la.id
             WHERE ${lowerEdge.sql} AND ${lowerAnchor.sql}
             GROUP BY lr.from_item_id
          ) lower_bound ON lower_bound.event_id = ci.id
          LEFT JOIN (
            SELECT ur.to_item_id AS event_id,
                   MIN(uad.sort_date) AS latest
              FROM relationship ur
              JOIN relationship_predicate up
                ON up.id = ur.predicate_id AND up.code = ?
              JOIN content_item ua ON ua.id = ur.from_item_id
              JOIN event_detail uad ON uad.content_item_id = ua.id
             WHERE ${upperEdge.sql} AND ${upperAnchor.sql}
             GROUP BY ur.to_item_id
          ) upper_bound ON upper_bound.event_id = ci.id`,
    params: [
      ...placeVisible.params,
      BOUND_PREDICATE,
      ...lowerEdge.params,
      ...lowerAnchor.params,
      BOUND_PREDICATE,
      ...upperEdge.params,
      ...upperAnchor.params,
    ],
  };
}

/**
 * Where an event sorts: its own date, or the window its bounds allow.
 *
 * A bounded event takes the earliest point it could have happened, so it lands
 * at the start of its window rather than drifting to the end of the list.
 */
const EFFECTIVE_SORT = `COALESCE(d.sort_date, lower_bound.earliest, upper_bound.latest)`;

/**
 * Chronological ordering.
 *
 * Events with nothing to place them at all sort last rather than at the
 * beginning of time. On the same day a coarser date sorts first, so "the
 * 1940s" precedes "2 June 1940": the wider claim contains the narrower one.
 * Below the day, the clock breaks the tie.
 *
 * A bounded event sorts after a dated one sharing its key, because "after the
 * pogrom" is strictly after the pogrom -- it borrowed that date from the very
 * event it is known to follow, and must not tie with it.
 */
const CHRONOLOGICAL_ORDER = `
  ORDER BY ${EFFECTIVE_SORT} IS NULL ASC,
           ${EFFECTIVE_SORT} ASC,
           d.sort_date IS NULL ASC,
           FIELD(d.start_precision, 'decade', 'year', 'month', 'day', 'hour', 'minute') ASC,
           d.start_time IS NULL ASC,
           d.start_time ASC,
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
  start_time: string | null;
  end_time: string | null;
  start_precision: DatePrecision;
  end_precision: DatePrecision;
  is_circa: number;
  place_slug: string | null;
  place_title: string | null;
  bound_earliest: Date | string | null;
  bound_latest: Date | string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : String(value).slice(0, 10);
}

function toEntry(row: EventRow): TimelineEntry {
  const dates: EventDates = {
    startDate: isoOrNull(row.start_date),
    endDate: isoOrNull(row.end_date),
    startTime: row.start_time === null ? null : String(row.start_time),
    endTime: row.end_time === null ? null : String(row.end_time),
    startPrecision: row.start_precision,
    endPrecision: row.end_precision,
    isCirca: row.is_circa === 1,
  };

  const earliest = isoOrNull(row.bound_earliest);
  const latest = isoOrNull(row.bound_latest);
  // Bounds are only interesting where the event does not date itself. An event
  // with both a date and a bound is already placed; the bound stays visible on
  // its page as an ordinary relationship.
  const bounded = dates.startDate === null && dates.endDate === null;

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
    // The anchors' names are filled in afterwards, by `attachBounds`; the SQL
    // supplies only the window, because that is what ordering needs before the
    // page is cut.
    //
    // Set for every undated event, not only those with a window: an anchor
    // that is itself undated still says something true about the order, and
    // "after the pogrom" is worth printing even when the pogrom is undated
    // too. `attachBounds` clears this again if no anchor turns out visible.
    bounds: bounded ? { after: [], before: [], earliest, latest } : null,
  };
}

/**
 * Names the anchors behind each bounded entry, and labels it.
 *
 * A second query rather than more joins: the window the SQL aggregated is what
 * ORDER BY needs before LIMIT cuts the page, while the titles are only needed
 * for the handful of rows that survive it.
 *
 * Filtered on the edge and on the anchor, exactly as the aggregate was, so the
 * two agree about which anchors exist.
 */
async function attachBounds(
  db: Pool | PoolConnection,
  entries: TimelineEntry[],
  viewer: Viewer,
): Promise<void> {
  const bounded = entries.filter((entry) => entry.bounds !== null);
  if (bounded.length === 0) return;

  const ids = bounded.map((entry) => entry.id);
  const placeholders = ids.map(() => '?').join(', ');
  const edge = visibilityFilter(viewer, 'r');
  const anchor = visibilityFilter(viewer, 'anchor');

  const rows = await queryRows<
    RowDataPacket & {
      event_id: number;
      direction: string;
      anchor_id: number;
      slug: string;
      title: string;
      start_date: Date | string | null;
      end_date: Date | string | null;
      start_time: string | null;
      end_time: string | null;
      start_precision: DatePrecision;
      end_precision: DatePrecision;
      is_circa: number;
    }
  >(
    db,
    `SELECT r.from_item_id AS event_id, 'after' AS direction,
            anchor.id AS anchor_id, anchor.slug, anchor.title,
            ad.start_date, ad.end_date, ad.start_time, ad.end_time,
            ad.start_precision, ad.end_precision, ad.is_circa
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id AND p.code = ?
       JOIN content_item anchor ON anchor.id = r.to_item_id
       JOIN event_detail ad ON ad.content_item_id = anchor.id
      WHERE r.from_item_id IN (${placeholders}) AND ${edge.sql} AND ${anchor.sql}
      UNION ALL
     SELECT r.to_item_id AS event_id, 'before' AS direction,
            anchor.id AS anchor_id, anchor.slug, anchor.title,
            ad.start_date, ad.end_date, ad.start_time, ad.end_time,
            ad.start_precision, ad.end_precision, ad.is_circa
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id AND p.code = ?
       JOIN content_item anchor ON anchor.id = r.from_item_id
       JOIN event_detail ad ON ad.content_item_id = anchor.id
      WHERE r.to_item_id IN (${placeholders}) AND ${edge.sql} AND ${anchor.sql}
      ORDER BY start_date ASC, title ASC`,
    [
      BOUND_PREDICATE,
      ...ids,
      ...edge.params,
      ...anchor.params,
      BOUND_PREDICATE,
      ...ids,
      ...edge.params,
      ...anchor.params,
    ],
  );

  const byId = new Map(bounded.map((entry) => [entry.id, entry]));

  for (const row of rows) {
    const entry = byId.get(Number(row.event_id));
    if (entry?.bounds === undefined || entry.bounds === null) continue;

    const anchorDates: EventDates = {
      startDate: isoOrNull(row.start_date),
      endDate: isoOrNull(row.end_date),
      startTime: row.start_time === null ? null : String(row.start_time),
      endTime: row.end_time === null ? null : String(row.end_time),
      startPrecision: row.start_precision,
      endPrecision: row.end_precision,
      isCirca: row.is_circa === 1,
    };

    const named: EventBoundAnchor = {
      id: Number(row.anchor_id),
      title: String(row.title),
      href: referenceHref('event', String(row.slug)),
      dateLabel: anchorDates.startDate === null ? null : formatEventDate(anchorDates),
    };

    if (row.direction === 'after') entry.bounds.after.push(named);
    else entry.bounds.before.push(named);
  }

  for (const entry of bounded) {
    if (entry.bounds === null) continue;
    // An anchor that turned out to be invisible leaves nothing to say, so the
    // entry falls back to plainly undated rather than hinting at a bound.
    if (entry.bounds.after.length === 0 && entry.bounds.before.length === 0) {
      entry.bounds = null;
      continue;
    }
    // The binding anchor first, which is the one the label should name: the
    // LATEST event it is known to follow, and the EARLIEST it is known to
    // precede. Those are the two that actually narrow the window.
    entry.bounds.after.reverse();
    entry.dateLabel = formatEventBounds(entry.bounds) ?? entry.dateLabel;
  }
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

  const items = rows.map(toEntry);
  await attachBounds(db, items, viewer);
  return { items, total: Number(totalRow?.total ?? 0) };
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

  if (row === null) return null;
  const entry = toEntry(row);
  await attachBounds(db, [entry], viewer);
  return entry;
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

  const items = rows.map(toEntry);
  await attachBounds(db, items, viewer);
  return items;
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
  const precisionRank = (precision: DatePrecision): number => DATE_PRECISIONS.indexOf(precision);

  return [...entries].sort((left, right) => {
    const leftKey = effectiveKey(left);
    const rightKey = effectiveKey(right);

    if (leftKey === null && rightKey !== null) return 1;
    if (leftKey !== null && rightKey === null) return -1;
    if (leftKey !== null && rightKey !== null && leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1;
    }

    // "After the pogrom" is strictly after the pogrom: it borrowed that date
    // from the event it follows, so it must not tie with it.
    const leftBounded = left.dates.startDate === null && left.dates.endDate === null;
    const rightBounded = right.dates.startDate === null && right.dates.endDate === null;
    if (leftBounded !== rightBounded) return leftBounded ? 1 : -1;

    const byPrecision =
      precisionRank(left.dates.startPrecision) - precisionRank(right.dates.startPrecision);
    if (byPrecision !== 0) return byPrecision;

    const leftTime = left.dates.startTime ?? '';
    const rightTime = right.dates.startTime ?? '';
    if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;

    if (left.title !== right.title) return left.title < right.title ? -1 : 1;
    return left.id - right.id;
  });
}

/** What an entry sorts by: its own date, or the start of its bounded window. */
function effectiveKey(entry: TimelineEntry): string | null {
  return (
    entry.dates.startDate ??
    entry.dates.endDate ??
    entry.bounds?.earliest ??
    entry.bounds?.latest ??
    null
  );
}

// --- Writing bounds --------------------------------------------------------

export interface EventBoundsInput {
  /** Slugs of events this one is known to follow. */
  afterSlugs: readonly string[];
  /** Slugs of events this one is known to precede. */
  beforeSlugs: readonly string[];
  /**
   * Visibility for the edges written here.
   *
   * The event form passes the event's own, which is the intuitive reading: a
   * published event's bounds are published with it. It is safe regardless,
   * because every read filters the anchor as well as the edge -- a public
   * bound pointing at a private event still shows nothing.
   */
  visibility: Visibility;
}

/**
 * Replaces the relative bounds recorded for one event.
 *
 * Wholesale, in one transaction, for the same reason `rebuildReferences`
 * replaces rather than diffs: the form is the statement of what the bounds
 * are, and a diff would be a second place for the two to disagree.
 *
 * Only `happened_after` edges are touched, and only those in the direction
 * being edited. A bound is one fact seen from two sides -- "X after A" is the
 * row "A before X" -- so editing X's list does change what A's form shows.
 * That is correct, and it is why the two directions are replaced separately
 * rather than everything touching the event being cleared at once.
 *
 * Returns the slugs that named no event, for the operator to fix; an unknown
 * slug is dropped rather than failing the save.
 */
export async function setEventBounds(
  pool: Pool,
  eventId: number,
  input: EventBoundsInput,
): Promise<{ unresolved: string[] }> {
  return withTransaction(pool, async (connection) => {
    const predicate = await queryOne<RowDataPacket & { id: number }>(
      connection,
      'SELECT id FROM relationship_predicate WHERE code = ?',
      [BOUND_PREDICATE],
    );
    // The operator may have deleted the predicate; that is their prerogative,
    // and it simply means no bounds can be recorded.
    if (predicate === null) return { unresolved: [] };

    const predicateId = Number(predicate.id);
    const unresolved: string[] = [];

    const resolve = async (slugs: readonly string[]): Promise<number[]> => {
      const ids: number[] = [];
      for (const slug of slugs) {
        const row = await queryOne<RowDataPacket & { id: number }>(
          connection,
          `SELECT id FROM content_item WHERE kind = 'event' AND slug = ?`,
          [slug],
        );
        if (row === null) unresolved.push(slug);
        else if (Number(row.id) !== eventId) ids.push(Number(row.id));
      }
      return ids;
    };

    const afterIds = await resolve(input.afterSlugs);
    const beforeIds = await resolve(input.beforeSlugs);

    // "X after A" is the edge X -> A.
    await execute(
      connection,
      'DELETE FROM relationship WHERE from_item_id = ? AND predicate_id = ?',
      [eventId, predicateId],
    );
    // "X before B" is the edge B -> X, read from the other end.
    await execute(
      connection,
      'DELETE FROM relationship WHERE to_item_id = ? AND predicate_id = ?',
      [eventId, predicateId],
    );

    for (const anchorId of afterIds) {
      await execute(
        connection,
        `INSERT IGNORE INTO relationship (from_item_id, to_item_id, predicate_id, visibility)
         VALUES (?, ?, ?, ?)`,
        [eventId, anchorId, predicateId, input.visibility],
      );
    }

    for (const anchorId of beforeIds) {
      await execute(
        connection,
        `INSERT IGNORE INTO relationship (from_item_id, to_item_id, predicate_id, visibility)
         VALUES (?, ?, ?, ?)`,
        [anchorId, eventId, predicateId, input.visibility],
      );
    }

    return { unresolved };
  });
}

/** The bounds recorded for one event, as the admin form's two fields. */
export async function findEventBoundSlugs(
  db: Pool | PoolConnection,
  eventId: number,
): Promise<{ afterSlugs: string[]; beforeSlugs: string[] }> {
  const rows = await queryRows<RowDataPacket & { direction: string; slug: string }>(
    db,
    `SELECT 'after' AS direction, anchor.slug
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id AND p.code = ?
       JOIN content_item anchor ON anchor.id = r.to_item_id
      WHERE r.from_item_id = ?
      UNION ALL
     SELECT 'before' AS direction, anchor.slug
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id AND p.code = ?
       JOIN content_item anchor ON anchor.id = r.from_item_id
      WHERE r.to_item_id = ?
      ORDER BY slug ASC`,
    [BOUND_PREDICATE, eventId, BOUND_PREDICATE, eventId],
  );

  return {
    afterSlugs: rows.filter((row) => row.direction === 'after').map((row) => String(row.slug)),
    beforeSlugs: rows.filter((row) => row.direction === 'before').map((row) => String(row.slug)),
  };
}

/** Splits a comma- or space-separated slug list from a form field. */
export function parseSlugList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\s]+/)
    .map((slug) => slug.trim())
    .filter((slug) => /^[a-z0-9-]{1,190}$/.test(slug));
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
  /**
   * True when the span is the window the event could have fallen in, derived
   * from its bounds, rather than the period it is known to have occupied. The
   * template draws the two differently: a reader must not mistake a bounded
   * guess for a dated fact.
   */
  uncertain: boolean;
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
 * The years an entry occupies on the band, and whether that is a claim or a
 * window.
 *
 * A dated event spans the period it ran for. A bounded one spans everything
 * between its anchors -- which is the honest drawing, because the event is
 * somewhere in there and the sources do not say where. An event with only one
 * bound gets a window running to that bound and no further.
 */
function placement(entry: TimelineEntry): { from: number; to: number; uncertain: boolean } | null {
  const start = eventYear(entry.dates);
  if (start !== null) {
    return {
      from: start,
      to: Math.max(eventEndYear(entry.dates) ?? start, start),
      uncertain: false,
    };
  }

  const bounds = entry.bounds;
  if (bounds === null) return null;

  const earliest = yearOf(bounds.earliest);
  const latest = yearOf(bounds.latest);
  if (earliest === null && latest === null) return null;

  const from = earliest ?? latest ?? 0;
  const to = latest ?? earliest ?? 0;
  return { from: Math.min(from, to), to: Math.max(from, to), uncertain: true };
}

function yearOf(iso: string | null): number | null {
  return parseIsoDate(iso)?.year ?? null;
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
  const placed = entries.filter((entry) => placement(entry) !== null);
  const undated = entries.length - placed.length;
  if (placed.length === 0) return null;

  const windows = placed.map((entry) => placement(entry) ?? { from: 0, to: 0, uncertain: false });
  const firstYear = Math.min(...windows.map((window) => window.from));
  const lastYear = Math.max(...windows.map((window) => window.to));
  // A single-year chronology still needs a non-zero span to divide by.
  const range = Math.max(lastYear - firstYear, 1);

  const scale = (year: number): number => ((year - firstYear) / range) * BAND_WIDTH;

  // Greedy row packing: a span goes in the first row whose last span ends
  // before it starts, so overlapping events stack instead of colliding.
  const rowEnds: number[] = [];
  const spans: BandSpan[] = [];

  for (const entry of sortEntries(placed)) {
    const window = placement(entry);
    if (window === null) continue;

    const x = scale(window.from);
    const width = Math.max(scale(window.to) - x, BAND_MIN_SPAN);

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
      startYear: window.from,
      endYear: window.to,
      // Drawn differently, because it means something different: this is the
      // window the event could have fallen in, not the span it occupied.
      uncertain: window.uncertain,
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
