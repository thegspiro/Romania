/**
 * Taking a chronology away: CSV for a spreadsheet, iCalendar for a calendar.
 *
 * Pure serialisers. Neither decides anything about visibility -- they are
 * handed entries that `listTimeline` has already filtered, so an export can
 * only ever contain what its viewer could read a page at a time. That is the
 * whole safety argument, and it is why nothing here takes a `Viewer` or a
 * database handle: there is no second place for the rule to be applied, and so
 * no second place for it to be forgotten.
 *
 * Both formats carry a trap that is easy to miss.
 *
 * **A spreadsheet executes what it is given.** A title beginning `=`, `+`, `-`,
 * `@`, a tab or a carriage return is a formula to Excel and to Sheets, and
 * quoting does not stop it. The titles here are the operator's own, but the
 * operator is exactly who opens the file, so every field is neutralised.
 *
 * **iCalendar is a wire format, not a text file.** CRLF everywhere, lines
 * folded at 75 octets without splitting a character, and `\ ; ,` and newlines
 * escaped inside TEXT values. A reader that meets an unfolded 200-character
 * SUMMARY does not warn; it silently drops the event.
 */
import {
  UNDATED_LABEL,
  claimsTime,
  formatEventBounds,
  instantOf,
  type DatePrecision,
  type EventDates,
  type TimelineEntry,
} from './timeline.js';

const MS_PER_DAY = 86_400_000;

/**
 * A UTF-8 byte-order mark.
 *
 * Without it Excel reads the file in the machine's code page and "Ia\u015fi"
 * arrives mangled. Written as an escape rather than as the character itself,
 * which is invisible in a diff.
 */
const BOM = '\uFEFF';

// --- CSV --------------------------------------------------------------------

const CSV_COLUMNS: readonly string[] = Object.freeze([
  'Date',
  'Start date',
  'Start time',
  'End date',
  'End time',
  'Precision',
  'Approximate',
  'Relative to',
  'Title',
  'Place',
  'Visibility',
  'Summary',
  'URL',
]);

/**
 * A chronology as RFC 4180 CSV.
 *
 * The stored ISO dates are exported alongside the formatted label, because a
 * spreadsheet needs something it can sort on -- but a year-precision row stores
 * `1944-01-01`, so the `Precision` column travels with them. Without it the
 * file would assert a day that the record does not, which is the one thing this
 * codebase will not let a date do.
 *
 * An undated event is kept, with an empty date and whatever its bounds say.
 * Dropping it would make the export disagree with the page it came from.
 */
export function toCsv(entries: readonly TimelineEntry[], origin: string): string {
  const base = origin.replace(/\/+$/, '');
  const rows = [CSV_COLUMNS.map(csvField).join(',')];

  for (const entry of entries) {
    rows.push(
      [
        entry.dateLabel === UNDATED_LABEL ? '' : entry.dateLabel,
        entry.dates.startDate ?? '',
        timeFor(entry.dates, 'start'),
        entry.dates.endDate ?? '',
        timeFor(entry.dates, 'end'),
        entry.dates.startDate !== null ? entry.dates.startPrecision : entry.dates.endPrecision,
        entry.dates.isCirca ? 'yes' : '',
        entry.bounds === null ? '' : (formatEventBounds(entry.bounds) ?? ''),
        entry.title,
        entry.place?.title ?? '',
        entry.visibility,
        entry.summary ?? '',
        `${base}${entry.href}`,
      ]
        .map(csvField)
        .join(','),
    );
  }

  // CRLF, as RFC 4180 specifies, and a BOM so Excel reads it as UTF-8.
  return `${BOM}${rows.join('\r\n')}\r\n`;
}

/** The stored clock, but only where the precision claims one. */
function timeFor(dates: EventDates, edge: 'start' | 'end'): string {
  const precision = edge === 'start' ? dates.startPrecision : dates.endPrecision;
  if (!claimsTime(precision)) return '';
  return (edge === 'start' ? dates.startTime : dates.endTime) ?? '';
}

/** Characters that make a spreadsheet treat the rest of the field as code. */
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvField(value: string): string {
  // Neutralise first, then quote. Quoting alone does not stop a formula: Excel
  // strips the quotes and evaluates what is inside.
  const neutral = CSV_FORMULA_LEAD.test(value) ? `'${value}` : value;
  return `"${neutral.replaceAll('"', '""')}"`;
}

// --- iCalendar ---------------------------------------------------------------

/**
 * A chronology as an iCalendar feed.
 *
 * Three decisions worth stating.
 *
 * **An event with nothing to place it is omitted.** A VEVENT has no valid form
 * without a DTSTART, and inventing one would put a date on a record that
 * carries none. The CSV, which has no such constraint, keeps it.
 *
 * **A coarse date becomes the whole unit it names.** A year-precision event is
 * an all-day span over that year. A calendar has no way to draw "somewhere in
 * 1943", and a span is at least never narrower than the truth; the formatted
 * label travels in the DESCRIPTION so the reader sees what was actually
 * claimed. `unknown` is read as the year, the same as everywhere else.
 *
 * **A time is floating, never UTC.** The record stores 14:30 and does not say
 * in which zone, so the value is written without a `Z`: iCalendar's floating
 * time, which reads as local wherever the calendar is opened. Stamping it `Z`
 * would assert a zone nobody recorded.
 */
export function toICalendar(
  entries: readonly TimelineEntry[],
  origin: string,
  now: Date = new Date(),
): string {
  const base = origin.replace(/\/+$/, '');
  const host = hostOf(base);
  const stamp = utcStamp(now);

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dissertation research//Timeline//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const entry of entries) {
    const window = calendarWindow(entry.dates);
    if (window === null) continue;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${entry.slug}@${host}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(...window.lines);
    lines.push(`SUMMARY:${icsText(entry.title)}`);
    if (entry.place !== null) lines.push(`LOCATION:${icsText(entry.place.title)}`);

    const description = [
      entry.dateLabel,
      entry.bounds === null ? null : formatEventBounds(entry.bounds),
      entry.summary,
    ].filter((part): part is string => part !== null && part !== '');
    if (description.length > 0) lines.push(`DESCRIPTION:${icsText(description.join('\n'))}`);

    lines.push(`URL:${icsText(`${base}${entry.href}`)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** DTSTART and DTEND for one event, or null when nothing places it. */
function calendarWindow(dates: EventDates): { lines: string[] } | null {
  // `unknown` says nothing about how much of the value is meant, so it is read
  // as the year -- the same answer `formatEventDate` gives.
  const read = (precision: DatePrecision): DatePrecision =>
    precision === 'unknown' ? 'year' : precision;
  const resolved: EventDates = {
    ...dates,
    startPrecision: read(dates.startPrecision),
    endPrecision: read(dates.endPrecision),
  };

  const start = instantOf(resolved, 'start');
  if (start === null) return null;
  const end = instantOf(resolved, 'end');
  // The schema permits an end before its start; a VEVENT with DTEND <= DTSTART
  // is rejected outright by some readers and silently dropped by others.
  const finish = end === null || end <= start ? start + MS_PER_DAY : end;

  const precision = dates.startDate !== null ? dates.startPrecision : dates.endPrecision;
  const time = dates.startDate !== null ? dates.startTime : dates.endTime;
  if (claimsTime(precision) && time !== null) {
    return {
      lines: [`DTSTART:${floatingStamp(start)}`, `DTEND:${floatingStamp(finish)}`],
    };
  }

  // All-day, where DTEND is exclusive: a one-day event ends on the next day.
  return {
    lines: [`DTSTART;VALUE=DATE:${dateStamp(start)}`, `DTEND;VALUE=DATE:${dateStamp(finish)}`],
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function dateStamp(instant: number): string {
  const date = new Date(instant);
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;
}

function floatingStamp(instant: number): string {
  const date = new Date(instant);
  return `${dateStamp(instant)}T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}`;
}

function utcStamp(now: Date): string {
  return `${floatingStamp(now.getTime())}Z`;
}

/** The host part of the public base URL, for a UID that is globally unique. */
function hostOf(base: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(base);
  return match?.[1] ?? 'localhost';
}

/** Escaping for an iCalendar TEXT value. The order matters: backslash first. */
function icsText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll(/\r\n|\r|\n/g, '\\n');
}

const ICS_LINE_OCTETS = 75;
const encoder = new TextEncoder();

/**
 * Folds a content line at 75 octets, counting UTF-8 bytes.
 *
 * Iterated by code point, never by array index, so a fold cannot land in the
 * middle of a character: half a multi-byte sequence is not merely ugly, it
 * makes the file invalid. A continuation line begins with one space, which
 * counts toward its own 75.
 */
function fold(line: string): string {
  let folded = '';
  let current = '';
  let octets = 0;

  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = folded === '' ? ICS_LINE_OCTETS : ICS_LINE_OCTETS - 1;
    if (octets + size > limit) {
      folded += `${folded === '' ? '' : ' '}${current}\r\n`;
      current = '';
      octets = 0;
    }
    current += char;
    octets += size;
  }

  return folded + (folded === '' ? '' : ' ') + current;
}
