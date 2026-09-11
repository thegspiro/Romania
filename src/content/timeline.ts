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

/**
 * The earliest and latest years this module will place on an axis.
 *
 * Not a claim about history: a guard. MySQL under a permissive `sql_mode` can
 * hold `0000-00-00`, and one such row would drag a chronology's axis back to
 * year zero and squeeze every real event into a sliver at the right-hand edge.
 * Anything outside this window is treated as no date at all, which the page
 * already has an honest affordance for.
 */
const MIN_YEAR = 1;
const MAX_YEAR = 3000;

/**
 * A stored `YYYY-MM-DD`, validated against the calendar.
 *
 * The shape test alone is not enough: `1940-13-45` matches it, and passing that
 * to a `DATE` comparison or to `Date.UTC` produces a silently wrong answer
 * rather than an error. February is checked against the actual year, so
 * `1943-02-29` is rejected and `1944-02-29` is not.
 */
function parseIsoDate(value: string | null): DateParts | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;

  const [, yearText, monthText, dayText] = match;
  if (yearText === undefined || monthText === undefined || dayText === undefined) return null;

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return { year, month, day };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** True when a string is a real calendar date this module will accept. */
export function isCalendarDate(value: string): boolean {
  return parseIsoDate(value) !== null;
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

// --- Instants on an axis ---------------------------------------------------

/*
 * A caveat this module cannot fix, and should not hide.
 *
 * Everything below is proleptic Gregorian, because that is what JavaScript's
 * Date arithmetic is. Romania kept the Julian calendar until 1919, so an Old
 * Style date transcribed verbatim from a pre-1919 source will be placed about
 * thirteen days from where a Gregorian reader expects it. That was harmless
 * while the band was year-granular; now that a day is a position, it is worth
 * stating. Converting calendars is its own change set, and would need the
 * record to say which calendar a date was written in -- which it does not.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * A UTC instant, built the only safe way.
 *
 * Not `Date.UTC`, which maps years 0-99 to 1900+y: one `0042-01-01` would drag
 * a chronology's axis back two millennia. Not `new Date(string)` or
 * `Date.parse` either -- `new Date('1943-06-02T14:30')` carries no zone and is
 * read as *local*, which is invisible on a UTC machine and wrong on the
 * operator's.
 *
 * Out-of-range month and day values normalise the way the calendar does, which
 * is what the tick generator relies on to step from December into January.
 */
function utcInstant(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getTime();
}

/** The calendar parts of an instant, UTC. The inverse of `utcInstant`. */
function partsOfInstant(instant: number): DateParts {
  const date = new Date(instant);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * The half-open interval a stored endpoint actually names.
 *
 * Half-open so adjacent units abut with no seam: 1943 ends where 1944 begins,
 * and a minute-precision event still has a non-zero extent.
 */
interface EndpointUnit {
  start: number;
  /** Exclusive. Equal to `start` at `unknown`, which names no interval. */
  end: number;
}

function endpointUnit(
  iso: string | null,
  time: string | null,
  precision: DatePrecision,
): EndpointUnit | null {
  const parts = parseIsoDate(iso);
  if (parts === null) return null;
  const { year, month, day } = parts;

  switch (precision) {
    case 'decade': {
      const first = Math.floor(year / 10) * 10;
      return { start: utcInstant(first, 1, 1), end: utcInstant(first + 10, 1, 1) };
    }
    case 'year':
      return { start: utcInstant(year, 1, 1), end: utcInstant(year + 1, 1, 1) };
    case 'month':
      return { start: utcInstant(year, month, 1), end: utcInstant(year, month + 1, 1) };
    case 'day':
      return { start: utcInstant(year, month, day), end: utcInstant(year, month, day + 1) };
    case 'hour':
    case 'minute': {
      const clock = parseClock(time, precision);
      // The precision claims a time the column does not carry. Fall back to the
      // day, which is exactly what `formatEndpoint` prints in that case, so the
      // drawing and the label cannot disagree.
      if (clock === null) {
        return { start: utcInstant(year, month, day), end: utcInstant(year, month, day + 1) };
      }
      const start = utcInstant(year, month, day, clock.hour, clock.minute);
      return { start, end: start + (precision === 'minute' ? MS_PER_MINUTE : MS_PER_HOUR) };
    }
    case 'unknown': {
      // Not one day. `unknown` says the record does not vouch for how much of
      // the stored value is meant; a day-wide bar would assert the day.
      const start = utcInstant(year, month, day);
      return { start, end: start };
    }
  }
}

/** 'HH:MM' from the column as numbers, truncated to the precision claimed. */
function parseClock(
  value: string | null,
  precision: DatePrecision,
): { hour: number; minute: number } | null {
  if (value === null) return null;
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (match === null) return null;
  const [, hourText, minuteText] = match;
  if (hourText === undefined || minuteText === undefined) return null;

  const hour = Number(hourText);
  const minute = precision === 'minute' ? Number(minuteText) : 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Milliseconds from the Unix epoch for one edge of an event, UTC only.
 *
 * `start` is where the first known endpoint's unit opens; `end` is where the
 * last known endpoint's unit closes, exclusive. Either falls back to the other,
 * so "until 1945" still has a position. Null when nothing places the event.
 *
 * This is the whole conversion surface. Everything downstream is arithmetic on
 * a number, so there is no second place to get a time zone wrong.
 */
export function instantOf(dates: EventDates, edge: 'start' | 'end'): number | null {
  const start = endpointUnit(dates.startDate, dates.startTime, dates.startPrecision);
  const end = endpointUnit(dates.endDate, dates.endTime, dates.endPrecision);
  if (edge === 'start') return (start ?? end)?.start ?? null;
  return (end ?? start)?.end ?? null;
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
  // Validated against the calendar, not just the shape: `1940-13-45` matches
  // the pattern and would reach a MySQL DATE comparison as nonsense.
  if (isCalendarDate(trimmed)) return trimmed;
  if (/^\d{4}$/.test(trimmed)) {
    const bounded = edge === 'start' ? `${trimmed}-01-01` : `${trimmed}-12-31`;
    return isCalendarDate(bounded) ? bounded : null;
  }
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
 *
 * This is also the START of the span a date filter must overlap.
 */
const EFFECTIVE_SORT = `COALESCE(d.sort_date, lower_bound.earliest, upper_bound.latest)`;

/**
 * The END of that span -- the last moment the event could still be running.
 *
 * The fallback order matters and is not the mirror of `EFFECTIVE_SORT`. An
 * event with a date of its own takes `end_date` and then `sort_date`, so its
 * own dates always win and bounds are ignored -- matching `toEntry`, which
 * treats bounds as meaningful only when nothing else places the event. A
 * bounded event falls through to `upper_bound.latest` FIRST, because the end
 * of its window is the event it is known to precede; reaching for
 * `lower_bound.earliest` before that would end the span at its own beginning.
 */
const EFFECTIVE_END = `COALESCE(d.end_date, d.sort_date, upper_bound.latest, lower_bound.earliest)`;

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
  /**
   * Restrict to these event ids.
   *
   * For a caller that has already resolved which events it wants -- a timeline
   * block naming several subjects -- so the limit is applied once over the
   * union rather than once per subject. It only ever narrows: the visibility
   * filter is ANDed on top, so an id the viewer may not see stays unreadable.
   */
  eventIds?: readonly number[] | undefined;
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
  //
  // Both ends read the EFFECTIVE window, the same one the ordering uses. An
  // event dated only as "after the pogrom, before the armistice" has no dates
  // of its own, so filtering on `d.*` alone dropped it from the very range it
  // is known to fall in -- the page placed it and the band drew it, and then a
  // date filter made it vanish.
  const from = filters.from === undefined ? null : normaliseBoundary(filters.from, 'start');
  if (from !== null) {
    conditions.push(`${EFFECTIVE_END} >= ?`);
    params.push(from);
  }

  const to = filters.to === undefined ? null : normaliseBoundary(filters.to, 'end');
  if (to !== null) {
    conditions.push(`${EFFECTIVE_SORT} <= ?`);
    params.push(to);
  }

  if (filters.placeSlug !== undefined && /^[a-z0-9-]{1,190}$/.test(filters.placeSlug)) {
    conditions.push('place.slug = ?');
    params.push(filters.placeSlug);
  }

  if (filters.eventIds !== undefined) {
    // An empty list means "nothing qualified", which must return nothing --
    // not everything, which is what an omitted condition would do.
    if (filters.eventIds.length === 0) return { items: [], total: 0 };
    conditions.push(`ci.id IN (${filters.eventIds.map(() => '?').join(', ')})`);
    params.push(...filters.eventIds);
  }

  // Restricting to one subject's events resolves that subject under the
  // viewer's own filter first, so a private person's slug cannot be used to
  // ask which events touch them.
  if (filters.relatedSlug !== undefined && filters.relatedKind !== undefined) {
    const related = await findVisibleItem(db, filters.relatedKind, filters.relatedSlug, viewer);
    if (related === null) return { items: [], total: 0 };

    const ids = await relatedEventIds(db, [related.id], viewer);
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
  const [found] = await findVisibleItems(db, [{ kind, slug }], viewer);
  return found ?? null;
}

/**
 * Several subjects at once, under the viewer's filter.
 *
 * One query rather than one per subject, so a timeline block naming three
 * people costs the same as one naming one. An unknown or invisible subject is
 * simply absent from the result -- the caller contributes nothing for it,
 * rather than learning that it exists.
 */
async function findVisibleItems(
  db: Pool | PoolConnection,
  refs: readonly { kind: string; slug: string }[],
  viewer: Viewer,
): Promise<{ id: number; kind: string }[]> {
  const valid = refs.filter(
    (ref) => /^[a-z0-9-]{1,190}$/.test(ref.slug) && /^[a-z_]{1,20}$/.test(ref.kind),
  );
  if (valid.length === 0) return [];

  const visible = visibilityFilter(viewer, 'ci');
  // Placeholders only; every kind and slug is bound.
  const pairs = valid.map(() => '(?, ?)').join(', ');

  const rows = await queryRows<RowDataPacket & { id: number; kind: string }>(
    db,
    `SELECT ci.id, ci.kind FROM content_item ci
      WHERE (ci.kind, ci.slug) IN (${pairs}) AND ${visible.sql}`,
    [...valid.flatMap((ref) => [ref.kind, ref.slug]), ...visible.params],
  );

  return rows.map((row) => ({ id: Number(row.id), kind: String(row.kind) }));
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
  itemIds: readonly number[],
  viewer: Viewer,
): Promise<number[]> {
  if (itemIds.length === 0) return [];

  // Placeholders only; every id is bound.
  const ids = itemIds.map(() => '?').join(', ');
  const edge = visibilityFilter(viewer, 'r');
  const near = visibilityFilter(viewer, 'ci');
  const far = visibilityFilter(viewer, 'other');

  const rows = await queryRows<RowDataPacket & { event_id: number }>(
    db,
    `SELECT r.to_item_id AS event_id
       FROM relationship r
       JOIN content_item ci ON ci.id = r.from_item_id
       JOIN content_item other ON other.id = r.to_item_id
      WHERE r.from_item_id IN (${ids}) AND other.kind = ?
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}
      UNION
     SELECT r.from_item_id AS event_id
       FROM relationship r
       JOIN content_item ci ON ci.id = r.to_item_id
       JOIN content_item other ON other.id = r.from_item_id
      WHERE r.to_item_id IN (${ids}) AND other.kind = ?
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}
      UNION
     SELECT m.to_item_id AS event_id
       FROM mention m
       JOIN content_item ci ON ci.id = m.from_item_id
       JOIN content_item other ON other.id = m.to_item_id
      WHERE m.from_item_id IN (${ids}) AND other.kind = ?
        AND ${near.sql} AND ${far.sql}
      UNION
     SELECT m.from_item_id AS event_id
       FROM mention m
       JOIN content_item ci ON ci.id = m.to_item_id
       JOIN content_item other ON other.id = m.from_item_id
      WHERE m.to_item_id IN (${ids}) AND other.kind = ?
        AND ${near.sql} AND ${far.sql}`,
    [
      ...itemIds,
      'event',
      ...edge.params,
      ...near.params,
      ...far.params,
      ...itemIds,
      'event',
      ...edge.params,
      ...near.params,
      ...far.params,
      ...itemIds,
      'event',
      ...near.params,
      ...far.params,
      ...itemIds,
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
  const ids = await relatedEventIds(db, [itemId], viewer);
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
      // Resolve every subject first, then ask once. Asking per subject and
      // merging afterwards applied `limit` to each before the merge could see
      // it, so a subject with more events than the limit lost its tail and the
      // merged result was not the true top-N. It also cost four or five
      // round-trips per subject.
      const subjects = await findVisibleItems(db, directive.about, viewer);
      const ids = [
        ...new Set(
          await relatedEventIds(
            db,
            subjects.map((subject) => subject.id),
            viewer,
          ),
        ),
      ];

      const result = await listTimeline(db, viewer, {
        from: directive.from ?? undefined,
        to: directive.to ?? undefined,
        eventIds: ids,
        limit: directive.limit,
      });
      entries = result.items;
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

/**
 * One event, drawn.
 *
 * The axis is milliseconds, so a chronology confined to a single afternoon and
 * one covering five centuries are the same drawing at different scales. A bar's
 * **width is duration and nothing else**. Precision is carried by `point` and
 * `uncertain` instead, and drawn as a difference in fill rather than in length:
 * a width that meant "known only to the year" would be a duration claim the
 * record does not make, which is the same error `formatEventDate` exists to
 * prevent, committed in pixels instead of words.
 *
 * Three marks, three meanings:
 *
 * - a solid bar is a documented period, with both endpoints recorded;
 * - a soft fill (`point`) is an instant known to its stated precision;
 * - a dashed outline (`uncertain`) is a window derived from relative bounds.
 */
export interface BandSpan {
  id: number;
  title: string;
  href: string;
  visibility: Visibility;
  dateLabel: string;
  /** The extent the span stands for, as UTC instants. `end` is exclusive. */
  startInstant: number;
  endInstant: number;
  /** A single endpoint rather than a recorded period: drawn at a fixed width. */
  point: boolean;
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
  /** Already formatted by `formatEndpoint`. The template prints it. */
  label: string;
  x: number;
}

export interface BandLayout {
  width: number;
  height: number;
  /** Every y the template needs, so it computes none of them itself. */
  viewBox: string;
  tickY: number;
  axisY: number;
  spanHeight: number;
  labelY: number;
  /** The axis, after padding. Not what the events claim -- see `rangeLabel`. */
  firstInstant: number;
  lastInstant: number;
  /**
   * The range the *entries* cover, for the caption.
   *
   * Built from the endpoints themselves, never from the padded exclusive axis:
   * a chronology whose last event ends in 1943 must not caption as "to 1944",
   * which is a date the record does not carry.
   */
  rangeLabel: string;
  spans: BandSpan[];
  ticks: BandTick[];
  /** Events with no date at all: listed below, absent from the drawing. */
  undated: number;
  /**
   * Placed events the drawing ran out of rows for.
   *
   * Reported rather than crammed into the last row. Overlapping bars would let
   * a covering `<a>` steal another event's tooltip and click target, so a
   * reader could hover one bar and be shown a different event's title.
   */
  overflow: number;
}

const BAND_WIDTH = 960;
const BAND_ROW_HEIGHT = 22;
const BAND_SPAN_HEIGHT = 14;
/** Room above y=0 for the tick lines to overhang the first row. */
const BAND_TOP_PAD = 8;
/** Room below the rows for a tick label, with its descenders clear of the edge. */
const BAND_AXIS_HEIGHT = 24;
const BAND_LABEL_BASELINE = 14;
const BAND_MIN_SPAN = 4;
const BAND_MAX_ROWS = 24;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Coordinates are asserted rather than trusted.
 *
 * A `NaN` reaching an SVG attribute is discarded by the browser, and the bar
 * simply is not drawn -- an event that vanishes from a chronology with no trace,
 * which is the one failure this application treats as unacceptable. Better a
 * loud error in a test than a silent omission on a page.
 */
function finite(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new Error(`timeline band: ${what} is not a finite number`);
  return value;
}

/**
 * Where an entry sits on the axis, and what kind of claim that is.
 *
 * A dated event with both endpoints spans the period it ran for. A single
 * endpoint is a point: it is drawn at the instant its unit opens, at a fixed
 * width, because how long the unit is says nothing about how long the event
 * took. A bounded one spans everything between its anchors -- the honest
 * drawing, because the event is somewhere in there and the sources do not say
 * where.
 */
interface Placement {
  /** Where the drawn bar starts. */
  from: number;
  /** Where the drawn bar ends, exclusive. Equal to `from` for a point. */
  to: number;
  /** Where what the record claims ends, exclusive. Used for the caption only. */
  extentEnd: number;
  point: boolean;
  uncertain: boolean;
}

function placement(entry: TimelineEntry): Placement | null {
  const { dates } = entry;
  const start = endpointUnit(dates.startDate, dates.startTime, dates.startPrecision);
  const end = endpointUnit(dates.endDate, dates.endTime, dates.endPrecision);

  const first = start ?? end;
  const last = end ?? start;
  if (first !== null && last !== null) {
    // One endpoint recorded is an instant; two are a period.
    const point = dates.startDate === null || dates.endDate === null;
    // `start > end` is permitted by the schema, and so is a same-day pair of
    // times in the wrong order. Clamp rather than draw a negative width.
    const extentEnd = Math.max(last.end, first.start);
    return {
      from: first.start,
      to: point ? first.start : extentEnd,
      extentEnd,
      point,
      uncertain: false,
    };
  }

  const bounds = entry.bounds;
  if (bounds === null) return null;

  const earliest = parseIsoDate(bounds.earliest) ?? parseIsoDate(bounds.latest);
  const latest = parseIsoDate(bounds.latest) ?? parseIsoDate(bounds.earliest);
  if (earliest === null || latest === null) return null;

  const windowStart = utcInstant(earliest.year, earliest.month, earliest.day);
  const windowEnd = utcInstant(latest.year, latest.month, latest.day + 1);
  const from = Math.min(windowStart, windowEnd);
  const to = Math.max(windowStart, windowEnd);
  return { from, to, extentEnd: to, point: false, uncertain: true };
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
  const placements = new Map<number, Placement>();
  const placed: TimelineEntry[] = [];
  for (const entry of entries) {
    const where = placement(entry);
    if (where === null) continue;
    placements.set(entry.id, where);
    placed.push(entry);
  }

  const undated = entries.length - placed.length;
  // `Math.min()` of nothing is Infinity, which would make every coordinate NaN.
  // The guard and the spread stay in one function so they cannot drift apart.
  if (placed.length === 0) return null;

  const windows = [...placements.values()];
  const first = Math.min(...windows.map((window) => window.from));
  const last = Math.max(...windows.map((window) => window.to));

  /*
   * The axis is a quarter wider than the events need, split evenly, so the
   * first and last bars sit inside the drawing rather than flush against its
   * edges. A chronology with no natural width at all -- one event, or several
   * at the same instant -- is surveyed at the widest unit anyone claims, and at
   * least a day either way, because a point on its own implies no scale.
   */
  const natural = last - first;
  const units = windows.map((window) => window.extentEnd - window.from);
  const range = Math.max(
    natural > 0 ? natural * 1.25 : Math.max(MS_PER_DAY, ...units),
    MS_PER_MINUTE,
  );
  const pad = (range - natural) / 2;
  const axisFrom = finite(first - pad, 'axis start');
  const axisTo = finite(last + pad, 'axis end');

  const scale = (instant: number): number => ((instant - axisFrom) / range) * BAND_WIDTH;

  // Greedy row packing: a span goes in the first row whose last span ends
  // before it starts, so overlapping events stack instead of colliding.
  const rowEnds: number[] = [];
  const spans: BandSpan[] = [];
  let overflow = 0;

  for (const entry of sortEntries(placed)) {
    const window = placements.get(entry.id);
    if (window === undefined) continue;

    const x = finite(scale(window.from), 'span x');
    const width = finite(
      window.point ? BAND_MIN_SPAN : Math.max(scale(window.to) - x, BAND_MIN_SPAN),
      'span width',
    );

    let row = rowEnds.findIndex((end) => end <= x);
    if (row === -1) {
      if (rowEnds.length >= BAND_MAX_ROWS) {
        // Reported beneath the drawing rather than stacked on top of another
        // event's link. The cut falls in date order, which is the one ordering
        // uncorrelated with visibility.
        overflow += 1;
        continue;
      }
      rowEnds.push(0);
      row = rowEnds.length - 1;
    }
    rowEnds[row] = x + width + BAND_MIN_SPAN;

    spans.push({
      id: entry.id,
      title: entry.title,
      href: entry.href,
      visibility: entry.visibility,
      dateLabel: entry.dateLabel,
      startInstant: window.from,
      endInstant: window.extentEnd,
      point: window.point,
      uncertain: window.uncertain,
      x: round(x),
      width: round(width),
      y: row * BAND_ROW_HEIGHT,
    });
  }

  const rows = Math.max(rowEnds.length, 1);
  const axisY = rows * BAND_ROW_HEIGHT;
  const height = BAND_TOP_PAD + axisY + BAND_AXIS_HEIGHT;

  // The last instant the record actually reaches, not the exclusive end of the
  // unit after it: a chronology ending in 1943 must not caption as "to 1944".
  const lastClaimed = Math.max(
    ...windows.map((window) =>
      window.extentEnd > window.from ? window.extentEnd - 1 : window.from,
    ),
  );

  return {
    width: BAND_WIDTH,
    height,
    viewBox: `0 ${-BAND_TOP_PAD} ${BAND_WIDTH} ${height}`,
    tickY: -BAND_TOP_PAD,
    axisY,
    spanHeight: BAND_SPAN_HEIGHT,
    labelY: axisY + BAND_LABEL_BASELINE,
    firstInstant: axisFrom,
    lastInstant: axisTo,
    rangeLabel: rangeLabel(first, lastClaimed),
    spans,
    ticks: axisTicks(axisFrom, axisTo, first, scale),
    undated,
    overflow,
  };
}

/** "1943", or "1940 to 1944". Years only: a caption, not a claim about days. */
function rangeLabel(from: number, to: number): string {
  const firstYear = partsOfInstant(from).year;
  const lastYear = partsOfInstant(to).year;
  return firstYear === lastYear ? String(firstYear) : `${firstYear} to ${lastYear}`;
}

// --- The tick ladder -------------------------------------------------------

type TickUnit = 'minute' | 'hour' | 'day' | 'month' | 'year';

interface TickRung {
  unit: TickUnit;
  multiple: number;
  /** How a tick on this rung is spelled -- `formatEndpoint` does the spelling. */
  precision: DatePrecision;
  /** Nominal length, for *choosing* a rung. Never used to place a tick. */
  approx: number;
  /**
   * Characters the *qualified* label takes, for budgeting how many will fit.
   *
   * The full form, not the short one: the first tick always prints it and so
   * does every rollover, so budgeting on "July" would crowd the axis the
   * moment it had to say "July 1943".
   */
  labelChars: number;
}

function rung(unit: TickUnit, multiple: number): TickRung {
  switch (unit) {
    case 'minute':
      return {
        unit,
        multiple,
        precision: 'minute',
        approx: multiple * MS_PER_MINUTE,
        labelChars: 18,
      };
    case 'hour':
      return { unit, multiple, precision: 'hour', approx: multiple * MS_PER_HOUR, labelChars: 18 };
    case 'day':
      return { unit, multiple, precision: 'day', approx: multiple * MS_PER_DAY, labelChars: 16 };
    case 'month':
      return {
        unit,
        multiple,
        precision: 'month',
        approx: multiple * 30.44 * MS_PER_DAY,
        labelChars: 12,
      };
    case 'year':
      return {
        unit,
        multiple,
        precision: 'year',
        approx: multiple * 365.25 * MS_PER_DAY,
        labelChars: 4,
      };
  }
}

/**
 * Rungs *and* multiples, coarsening.
 *
 * Bare rungs are not enough: a thirty-year axis would get either thirty ticks
 * or three, depending on which side of the year/decade boundary it fell.
 */
const TICK_RUNGS: readonly TickRung[] = Object.freeze([
  ...[1, 5, 15, 30].map((multiple) => rung('minute', multiple)),
  ...[1, 3, 6, 12].map((multiple) => rung('hour', multiple)),
  ...[1, 2, 7, 14].map((multiple) => rung('day', multiple)),
  ...[1, 3, 6].map((multiple) => rung('month', multiple)),
  ...[1, 2, 5, 10, 25, 50, 100, 250, 500].map((multiple) => rung('year', multiple)),
]);

const COARSEST_RUNG = rung('year', 1000);
/** A stop against a runaway loop if a rung is ever mis-sized. */
const TICK_HARD_CAP = 200;
/** Rough advance of the band's 11px sans label, in user units. */
const TICK_CHAR_WIDTH = 6.5;
const TICK_LABEL_GAP = 24;

function maxTicks(candidate: TickRung): number {
  return Math.max(
    Math.floor(BAND_WIDTH / (candidate.labelChars * TICK_CHAR_WIDTH + TICK_LABEL_GAP)),
    2,
  );
}

/** The finest rung whose labels still fit across the band. */
function chooseRung(range: number): TickRung {
  for (const candidate of TICK_RUNGS) {
    if (range / candidate.approx <= maxTicks(candidate)) return candidate;
  }
  return COARSEST_RUNG;
}

/**
 * Round instants across the axis, labelled at the rung they mark.
 *
 * Month and coarser rungs step through the *calendar*, never by adding a
 * nominal number of milliseconds: a year approximated as 365.25 days drifts by
 * days over a long axis, and the tick line then visibly misses the bar it
 * labels. Minute, hour and day are exact in UTC, where no day is 23 hours long.
 */
function axisTicks(
  axisFrom: number,
  axisTo: number,
  fallback: number,
  scale: (instant: number) => number,
): BandTick[] {
  const chosen = chooseRung(Math.max(axisTo - axisFrom, 1));
  const instants = tickInstants(chosen, axisFrom, axisTo).filter((instant) => {
    const year = partsOfInstant(instant).year;
    return year >= MIN_YEAR && year <= MAX_YEAR;
  });

  // An axis narrower than one step of the coarsest rung would draw nothing at
  // all. Mark where the earliest event sits instead -- always a real date.
  if (instants.length === 0) instants.push(fallback);

  const ticks: BandTick[] = [];
  let previousQualifier: string | null = null;
  for (const instant of instants) {
    const current = qualifierOf(instant, chosen);
    ticks.push({
      label: tickLabel(instant, chosen, previousQualifier !== current),
      x: round(finite(scale(instant), 'tick x')),
    });
    previousQualifier = current;
  }
  return ticks;
}

function tickInstants(chosen: TickRung, from: number, to: number): number[] {
  const instants: number[] = [];
  const parts = partsOfInstant(from);

  if (chosen.unit === 'month' || chosen.unit === 'year') {
    let year = parts.year;
    let month = 1;
    if (chosen.unit === 'month') {
      // Counted from January, so a three-month rung lands on Jan/Apr/Jul/Oct.
      month = Math.floor((parts.month - 1) / chosen.multiple) * chosen.multiple + 1;
    } else {
      year = Math.floor(year / chosen.multiple) * chosen.multiple;
    }

    for (let step = 0; step < TICK_HARD_CAP; step += 1) {
      const instant = utcInstant(year, month, 1);
      if (instant > to) break;
      if (instant >= from) instants.push(instant);
      if (chosen.unit === 'month') month += chosen.multiple;
      else year += chosen.multiple;
    }
    return instants;
  }

  // Anchored one rung coarser than it steps, so the values read round: days
  // from the first of the month, hours from midnight, minutes from the hour.
  const anchor =
    chosen.unit === 'day'
      ? utcInstant(parts.year, parts.month, 1)
      : chosen.unit === 'hour'
        ? utcInstant(parts.year, parts.month, parts.day)
        : new Date(from).setUTCMinutes(0, 0, 0);
  const step = chosen.approx;

  let instant = anchor + Math.ceil((from - anchor) / step) * step;
  for (let count = 0; instant <= to && count < TICK_HARD_CAP; count += 1) {
    instants.push(instant);
    instant += step;
  }
  return instants;
}

/**
 * The component a reader would otherwise have to infer.
 *
 * A label is printed in full whenever this changes, so an axis crossing new
 * year reads `24 December`, `31 December`, `7 January 1945` rather than an
 * ambiguous `7 January`.
 */
function qualifierOf(instant: number, chosen: TickRung): string {
  const parts = partsOfInstant(instant);
  switch (chosen.unit) {
    case 'minute':
    case 'hour':
      return `${parts.year}-${parts.month}-${parts.day}`;
    case 'day':
    case 'month':
      return String(parts.year);
    case 'year':
      return '';
  }
}

function tickLabel(instant: number, chosen: TickRung, qualify: boolean): string {
  const parts = partsOfInstant(instant);
  const iso = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const date = new Date(instant);
  const time = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;

  // Through the module's one formatter, so a tick and an event cannot spell the
  // same date two ways.
  const full = formatEndpoint(iso, time, chosen.precision);
  if (full === null) return '';
  if (qualify) return full;

  // The short form is the full label with the part the reader already has
  // trimmed off -- derived from it rather than formatted afresh, so the two
  // cannot drift.
  switch (chosen.unit) {
    case 'minute':
    case 'hour': {
      const comma = full.lastIndexOf(', ');
      return comma === -1 ? full : full.slice(comma + 2);
    }
    case 'day':
    case 'month': {
      const suffix = ` ${parts.year}`;
      return full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
    }
    case 'year':
      return full;
  }
}
