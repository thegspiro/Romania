/**
 * The two export serialisers.
 *
 * Neither decides anything about visibility -- both are handed entries that
 * `listTimeline` has already filtered -- so what is asserted here is that the
 * files they produce are correct and safe to open: a spreadsheet must not
 * execute a title, and a calendar must not silently drop an event because a
 * line ran past 75 octets.
 */
import { describe, expect, it } from 'vitest';
import { toCsv, toICalendar } from '../../src/content/timeline-export.js';
import {
  formatEventDate,
  type EventDates,
  type TimelineEntry,
} from '../../src/content/timeline.js';

const ORIGIN = 'https://research.example/';
const STAMP = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));

function dates(overrides: Partial<EventDates> = {}): EventDates {
  return {
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    startPrecision: 'unknown',
    endPrecision: 'unknown',
    isCirca: false,
    ...overrides,
  };
}

function entry(id: number, overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  const entryDates = overrides.dates ?? dates();
  return {
    id,
    slug: `event-${id}`,
    title: `Event ${id}`,
    href: `/events/event-${id}`,
    visibility: 'public',
    summary: null,
    dates: entryDates,
    dateLabel: formatEventDate(entryDates),
    place: null,
    bounds: null,
    ...overrides,
  };
}

/** Splits CSV on record boundaries, respecting quoted fields. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const body = text.startsWith('﻿') ? text.slice(1) : text;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && body[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else field += char ?? '';
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('toCsv', () => {
  it('writes a header and one record per event', () => {
    const rows = csvRows(
      toCsv(
        [
          entry(1, {
            title: 'The Iași pogrom',
            dates: dates({
              startDate: '1941-06-29',
              startPrecision: 'day',
              endDate: '1941-07-06',
              endPrecision: 'day',
            }),
            place: { title: 'Iași', href: '/places/iasi' },
          }),
        ],
        ORIGIN,
      ),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.[0]).toBe('Date');
    const record = rows[1] ?? [];
    expect(record[0]).toBe('29 June 1941 – 6 July 1941');
    expect(record[1]).toBe('1941-06-29');
    expect(record[3]).toBe('1941-07-06');
    expect(record[5]).toBe('day');
    expect(record).toContain('The Iași pogrom');
    expect(record).toContain('Iași');
    // The origin's trailing slash must not double up.
    expect(record[record.length - 1]).toBe('https://research.example/events/event-1');
  });

  it('neutralises a title a spreadsheet would run', () => {
    // Quoting alone does not help: Excel strips the quotes and evaluates what
    // is inside. The titles are the operator's own, and the operator is
    // exactly who opens the file.
    for (const dangerous of ['=cmd|x', '+1+1', '-2+3', '@SUM(A1)', '\tlead', '\rlead']) {
      const csv = toCsv([entry(1, { title: dangerous })], ORIGIN);
      const record = csvRows(csv)[1] ?? [];
      expect(record).toContain(`'${dangerous}`);
    }
  });

  it('survives a title carrying a quote, a comma and a newline', () => {
    const title = 'He said "no", then\nleft';
    const record = csvRows(toCsv([entry(1, { title })], ORIGIN))[1] ?? [];
    expect(record).toContain(title);
  });

  it('keeps an undated event, with its bounds text', () => {
    const csv = toCsv(
      [
        entry(1, {
          bounds: {
            after: [{ id: 2, title: 'the pogrom', href: '/events/p', dateLabel: null }],
            before: [],
            earliest: null,
            latest: null,
          },
        }),
      ],
      ORIGIN,
    );

    const record = csvRows(csv)[1] ?? [];
    // Dropping it would make the export disagree with the page it came from.
    expect(record[0]).toBe('');
    expect(record).toContain('after the pogrom');
  });

  it('withholds a clock the precision does not claim', () => {
    const record =
      csvRows(
        toCsv(
          [
            entry(1, {
              dates: dates({ startDate: '1943-06-02', startTime: '14:30', startPrecision: 'day' }),
            }),
          ],
          ORIGIN,
        ),
      )[1] ?? [];
    expect(record[2]).toBe('');
  });

  it('starts with a BOM and ends every record with CRLF', () => {
    const csv = toCsv([entry(1)], ORIGIN);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.includes('\n') && !/[^\r]\n/.test(csv)).toBe(true);
  });
});

describe('toICalendar', () => {
  /** Unfolds continuation lines, which is what a real reader does first. */
  function unfold(text: string): string[] {
    return text.replaceAll('\r\n ', '').split('\r\n');
  }

  it('wraps the events in one calendar', () => {
    const lines = unfold(toICalendar([entry(1)], ORIGIN, STAMP));
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines.filter((line) => line === 'END:VCALENDAR')).toHaveLength(1);
  });

  it('uses CRLF throughout', () => {
    const ics = toICalendar(
      [entry(1, { dates: dates({ startDate: '1943-06-02' }) })],
      ORIGIN,
      STAMP,
    );
    expect(/[^\r]\n/.test(ics)).toBe(false);
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  it('writes a date-precision event as an all-day span with an exclusive end', () => {
    const lines = unfold(
      toICalendar(
        [entry(1, { dates: dates({ startDate: '1943-06-02', startPrecision: 'day' }) })],
        ORIGIN,
        STAMP,
      ),
    );
    expect(lines).toContain('DTSTART;VALUE=DATE:19430602');
    expect(lines).toContain('DTEND;VALUE=DATE:19430603');
  });

  it('writes a timed event as a floating time, never stamped UTC', () => {
    // The record stores 14:30 and does not say in which zone. A trailing Z
    // would assert one nobody wrote down.
    const lines = unfold(
      toICalendar(
        [
          entry(1, {
            dates: dates({
              startDate: '1943-06-02',
              startTime: '14:30',
              startPrecision: 'minute',
            }),
          }),
        ],
        ORIGIN,
        STAMP,
      ),
    );
    expect(lines).toContain('DTSTART:19430602T143000');
    expect(lines).toContain('DTEND:19430602T143100');
  });

  it('widens a coarse date to the whole unit it names', () => {
    const lines = unfold(
      toICalendar(
        [entry(1, { dates: dates({ startDate: '1944-01-01', startPrecision: 'year' }) })],
        ORIGIN,
        STAMP,
      ),
    );
    expect(lines).toContain('DTSTART;VALUE=DATE:19440101');
    expect(lines).toContain('DTEND;VALUE=DATE:19450101');
    // ...and the label says what was actually claimed.
    expect(lines.some((line) => line.startsWith('DESCRIPTION:1944'))).toBe(true);
  });

  it('reads an unknown precision as its year', () => {
    const lines = unfold(
      toICalendar([entry(1, { dates: dates({ startDate: '1943-06-02' }) })], ORIGIN, STAMP),
    );
    expect(lines).toContain('DTSTART;VALUE=DATE:19430101');
    expect(lines).toContain('DTEND;VALUE=DATE:19440101');
  });

  it('omits an event with nothing to place it', () => {
    // A VEVENT has no valid form without a DTSTART, and inventing one would put
    // a date on a record that carries none.
    const ics = toICalendar(
      [entry(1), entry(2, { dates: dates({ startDate: '1943-06-02' }) })],
      ORIGIN,
      STAMP,
    );
    expect(unfold(ics).filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('escapes the characters iCalendar reserves', () => {
    const lines = unfold(
      toICalendar(
        [
          entry(1, {
            title: 'Order 1,2; back\\slash',
            summary: 'first\nsecond',
            dates: dates({ startDate: '1943-06-02', startPrecision: 'day' }),
          }),
        ],
        ORIGIN,
        STAMP,
      ),
    );
    expect(lines).toContain('SUMMARY:Order 1\\,2\\; back\\\\slash');
    expect(lines.some((line) => line.includes('first\\nsecond'))).toBe(true);
  });

  it('folds a long line at 75 octets without splitting a character', () => {
    const title = `Ș${'a'.repeat(200)}`;
    const ics = toICalendar(
      [entry(1, { title, dates: dates({ startDate: '1943-06-02', startPrecision: 'day' }) })],
      ORIGIN,
      STAMP,
    );

    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Unfolding gets the title back byte for byte, multi-byte character intact.
    expect(unfold(ics)).toContain(`SUMMARY:${title}`);
  });

  it('gives each event a stable, globally unique id', () => {
    const lines = unfold(
      toICalendar(
        [entry(1, { slug: 'iasi-pogrom', dates: dates({ startDate: '1941-06-29' }) })],
        ORIGIN,
        STAMP,
      ),
    );
    expect(lines).toContain('UID:iasi-pogrom@research.example');
    expect(lines).toContain('DTSTAMP:20260102T030405Z');
  });
});
