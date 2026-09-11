/**
 * The pure half of the chronology: formatting, the block directive, ordering
 * and the band's geometry.
 *
 * These need no database because they decide nothing about visibility. What
 * they do decide is whether a stored date claims more certainty than the record
 * carries -- 1944-01-01 at year precision is "1944", never "1 January 1944" --
 * which is a correctness property of the scholarship, not of the software.
 */
import { describe, expect, it } from 'vitest';
import {
  UNDATED_LABEL,
  claimsTime,
  eventEndYear,
  eventYear,
  formatEventBounds,
  formatEventDate,
  isCalendarDate,
  layoutTimelineBand,
  normaliseBoundary,
  parseSlugList,
  parseTimelineDirective,
  sortEntries,
  timelineDirectiveKey,
  type EventBoundAnchor,
  type EventDates,
  type TimelineEntry,
} from '../../src/content/timeline.js';

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

describe('formatEventDate', () => {
  it('renders a day-precision date in full', () => {
    expect(formatEventDate(dates({ startDate: '1943-06-02', startPrecision: 'day' }))).toBe(
      '2 June 1943',
    );
  });

  it('renders a month-precision date without the day', () => {
    expect(formatEventDate(dates({ startDate: '1943-06-02', startPrecision: 'month' }))).toBe(
      'June 1943',
    );
  });

  it('renders a year-precision date as the year alone', () => {
    // The property that matters: the stored 01-01 is an artefact of the
    // column's type, not a claim about the first of January.
    expect(formatEventDate(dates({ startDate: '1944-01-01', startPrecision: 'year' }))).toBe(
      '1944',
    );
  });

  it('renders a decade-precision date as a decade', () => {
    expect(formatEventDate(dates({ startDate: '1943-01-01', startPrecision: 'decade' }))).toBe(
      '1940s',
    );
  });

  it('renders an unknown precision as the date as stored', () => {
    // Which is also exactly what the event page showed before this module
    // existed, so a row nobody has re-edited reads as it always did.
    expect(formatEventDate(dates({ startDate: '1943-06-02' }))).toBe('1943-06-02');
  });

  it('renders a range with a precision at each end', () => {
    expect(
      formatEventDate(
        dates({
          startDate: '1943-06-01',
          startPrecision: 'month',
          endDate: '1945-01-01',
          endPrecision: 'year',
        }),
      ),
    ).toBe('June 1943 – 1945');
  });

  it('collapses a range whose ends read the same', () => {
    expect(
      formatEventDate(
        dates({
          startDate: '1944-01-01',
          startPrecision: 'year',
          endDate: '1944-12-31',
          endPrecision: 'year',
        }),
      ),
    ).toBe('1944');
  });

  it('marks an approximate date without changing its precision', () => {
    expect(
      formatEventDate(dates({ startDate: '1943-01-01', startPrecision: 'year', isCirca: true })),
    ).toBe('c. 1943');
    // Approximate and precise at once is a real state: a diary entry dated to
    // the day by someone recalling it years later.
    expect(
      formatEventDate(dates({ startDate: '1943-06-02', startPrecision: 'day', isCirca: true })),
    ).toBe('c. 2 June 1943');
  });

  it('reads an end-only event as an upper bound', () => {
    expect(formatEventDate(dates({ endDate: '1945-01-01', endPrecision: 'year' }))).toBe(
      'until 1945',
    );
  });

  it('says so when there is no date at all', () => {
    expect(formatEventDate(dates())).toBe(UNDATED_LABEL);
  });
});

describe('time of day', () => {
  it('shows the clock at minute precision', () => {
    expect(
      formatEventDate(
        dates({ startDate: '1943-06-02', startTime: '14:30', startPrecision: 'minute' }),
      ),
    ).toBe('2 June 1943, 14:30');
  });

  it('truncates to the hour at hour precision', () => {
    // The same rule the date follows: the stored value is read only as far as
    // the precision claims, so 14:37 at Hour means the 14:00 hour.
    expect(
      formatEventDate(
        dates({ startDate: '1943-06-02', startTime: '14:37', startPrecision: 'hour' }),
      ),
    ).toBe('2 June 1943, 14:00');
  });

  it('hides a stored time below hour precision', () => {
    // A time can be left in the column by an edit that coarsened the
    // precision; showing it would claim a certainty that was withdrawn.
    expect(
      formatEventDate(
        dates({ startDate: '1943-06-02', startTime: '14:30', startPrecision: 'day' }),
      ),
    ).toBe('2 June 1943');
    expect(claimsTime('day')).toBe(false);
    expect(claimsTime('hour')).toBe(true);
    expect(claimsTime('minute')).toBe(true);
  });

  it('falls back to the date when the precision claims a time and none is stored', () => {
    expect(formatEventDate(dates({ startDate: '1943-06-02', startPrecision: 'minute' }))).toBe(
      '2 June 1943',
    );
  });

  it('carries a time on each end of a range', () => {
    expect(
      formatEventDate(
        dates({
          startDate: '1943-06-02',
          startTime: '09:00',
          startPrecision: 'minute',
          endDate: '1943-06-02',
          endTime: '17:15',
          endPrecision: 'minute',
        }),
      ),
    ).toBe('2 June 1943, 09:00 – 2 June 1943, 17:15');
  });
});

describe('formatEventBounds', () => {
  function anchor(title: string): EventBoundAnchor {
    return { id: 1, title, href: '/events/x', dateLabel: null };
  }

  it('reads as the sources do', () => {
    expect(
      formatEventBounds({
        after: [anchor('the Iasi pogrom')],
        before: [anchor('the armistice')],
        earliest: '1941-06-29',
        latest: '1944-08-23',
      }),
    ).toBe('after the Iasi pogrom, before the armistice');
  });

  it('states only the end it knows', () => {
    expect(
      formatEventBounds({
        after: [anchor('the pogrom')],
        before: [],
        earliest: null,
        latest: null,
      }),
    ).toBe('after the pogrom');
    expect(
      formatEventBounds({
        after: [],
        before: [anchor('the armistice')],
        earliest: null,
        latest: null,
      }),
    ).toBe('before the armistice');
  });

  it('is null when nothing places the event', () => {
    expect(formatEventBounds({ after: [], before: [], earliest: null, latest: null })).toBeNull();
  });
});

describe('normaliseBoundary and the calendar', () => {
  it('rejects a date that matches the shape but not the calendar', () => {
    // `1940-13-45` passes /^\d{4}-\d{2}-\d{2}$/ and would reach a MySQL DATE
    // comparison as nonsense.
    expect(isCalendarDate('1940-13-45')).toBe(false);
    expect(normaliseBoundary('1940-13-45', 'start')).toBeNull();
    expect(isCalendarDate('1943-02-29')).toBe(false);
    expect(isCalendarDate('1944-02-29')).toBe(true);
    expect(isCalendarDate('1940-04-31')).toBe(false);
  });

  it('rejects a year outside the window an axis can hold', () => {
    // MySQL can store 0000-00-00 under a permissive sql_mode; one such row
    // would drag a chronology's axis back to year zero.
    expect(isCalendarDate('0000-00-00')).toBe(false);
    expect(isCalendarDate('0000-01-01')).toBe(false);
    expect(isCalendarDate('9999-01-01')).toBe(false);
  });

  it('still accepts real dates and bare years', () => {
    expect(normaliseBoundary('1943-06-02', 'start')).toBe('1943-06-02');
    expect(normaliseBoundary('1940', 'start')).toBe('1940-01-01');
    expect(normaliseBoundary('1944', 'end')).toBe('1944-12-31');
  });
});

describe('parseSlugList', () => {
  it('splits on commas and whitespace', () => {
    expect(parseSlugList('the-pogrom, the-armistice')).toEqual(['the-pogrom', 'the-armistice']);
    expect(parseSlugList('one two')).toEqual(['one', 'two']);
  });

  it('drops anything that is not a slug', () => {
    expect(parseSlugList('Good Slug?, real-slug')).toEqual(['real-slug']);
    expect(parseSlugList('')).toEqual([]);
    expect(parseSlugList(undefined)).toEqual([]);
  });
});

describe('eventYear', () => {
  it('falls back to the end when only that is known', () => {
    expect(eventYear(dates({ endDate: '1945-05-08', endPrecision: 'day' }))).toBe(1945);
  });

  it('is null for an undated event', () => {
    expect(eventYear(dates())).toBeNull();
  });

  it('runs a decade to the end of its decade', () => {
    expect(eventEndYear(dates({ startDate: '1943-01-01', startPrecision: 'decade' }))).toBe(1949);
  });
});

describe('normaliseBoundary', () => {
  it('reads a bare year as the whole year', () => {
    expect(normaliseBoundary('1940', 'start')).toBe('1940-01-01');
    // Not the first of January: "to 1944" must include all of 1944.
    expect(normaliseBoundary('1944', 'end')).toBe('1944-12-31');
  });

  it('passes a full date through', () => {
    expect(normaliseBoundary('1940-06-02', 'start')).toBe('1940-06-02');
  });

  it('ignores anything else', () => {
    expect(normaliseBoundary('sometime', 'start')).toBeNull();
    expect(normaliseBoundary('', 'end')).toBeNull();
  });
});

describe('parseTimelineDirective', () => {
  it('reads the keys it knows', () => {
    const directive = parseTimelineDirective(
      ['about: person:ion-antonescu, place:iasi', 'from: 1940', 'to: 1944', 'limit: 5'].join('\n'),
    );

    expect(directive.about).toEqual([
      { kind: 'person', slug: 'ion-antonescu' },
      { kind: 'place', slug: 'iasi' },
    ]);
    expect(directive.from).toBe('1940-01-01');
    expect(directive.to).toBe('1944-12-31');
    expect(directive.limit).toBe(5);
  });

  it('ignores an unknown key rather than failing', () => {
    // The same tolerance parseReferences shows an unknown reference kind:
    // prose that happens to contain one is prose.
    const directive = parseTimelineDirective('colour: red\nfrom: 1940');
    expect(directive.from).toBe('1940-01-01');
  });

  it('drops an entry that is not a kind and a slug', () => {
    const directive = parseTimelineDirective('about: nonsense, essay:x, person:ion-antonescu');
    // `essay` is not one of the kinds an event connects to.
    expect(directive.about).toEqual([{ kind: 'person', slug: 'ion-antonescu' }]);
  });

  it('clamps an absurd limit', () => {
    expect(parseTimelineDirective('limit: 100000').limit).toBe(100);
    expect(parseTimelineDirective('limit: -3').limit).toBe(25);
  });

  it('defaults an empty body to the whole chronology', () => {
    const directive = parseTimelineDirective('');
    expect(directive.about).toEqual([]);
    expect(directive.from).toBeNull();
    expect(directive.to).toBeNull();
  });

  it('gives identical directives the same key', () => {
    const one = parseTimelineDirective('about: place:iasi\nfrom: 1940');
    const two = parseTimelineDirective('from: 1940\nabout: place:iasi');
    expect(timelineDirectiveKey(one)).toBe(timelineDirectiveKey(two));
  });
});

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

describe('sortEntries', () => {
  it('puts undated events last rather than at the beginning of time', () => {
    const ordered = sortEntries([
      entry(1),
      entry(2, { dates: dates({ startDate: '1943-01-01', startPrecision: 'year' }) }),
    ]);
    expect(ordered.map((item) => item.id)).toEqual([2, 1]);
  });

  it('puts a coarser date before a finer one on the same day', () => {
    // "the 1940s" contains "2 June 1940", so it is the wider claim and reads
    // first.
    const ordered = sortEntries([
      entry(1, { dates: dates({ startDate: '1940-01-01', startPrecision: 'year' }) }),
      entry(2, { dates: dates({ startDate: '1940-01-01', startPrecision: 'decade' }) }),
    ]);
    expect(ordered.map((item) => item.id)).toEqual([2, 1]);
  });

  it('sorts a bounded event at the start of its window', () => {
    const ordered = sortEntries([
      entry(1, { dates: dates({ startDate: '1945-01-01', startPrecision: 'year' }) }),
      entry(2, {
        bounds: { after: [], before: [], earliest: '1941-06-29', latest: '1944-08-23' },
      }),
      entry(3, { dates: dates({ startDate: '1940-01-01', startPrecision: 'year' }) }),
    ]);
    // Not shoved to the end with the undated: it is placed, just not precisely.
    expect(ordered.map((item) => item.id)).toEqual([3, 2, 1]);
  });

  it('breaks a tie on the same day by the clock', () => {
    const ordered = sortEntries([
      entry(1, {
        dates: dates({ startDate: '1943-06-02', startTime: '17:00', startPrecision: 'minute' }),
      }),
      entry(2, {
        dates: dates({ startDate: '1943-06-02', startTime: '09:00', startPrecision: 'minute' }),
      }),
    ]);
    expect(ordered.map((item) => item.id)).toEqual([2, 1]);
  });

  it('does not mutate the array it was given', () => {
    const input = [
      entry(1, { dates: dates({ startDate: '1945-01-01', startPrecision: 'year' }) }),
      entry(2, { dates: dates({ startDate: '1940-01-01', startPrecision: 'year' }) }),
    ];
    sortEntries(input);
    expect(input.map((item) => item.id)).toEqual([1, 2]);
  });
});

describe('layoutTimelineBand', () => {
  it('is null when nothing can be placed', () => {
    expect(layoutTimelineBand([])).toBeNull();
    expect(layoutTimelineBand([entry(1)])).toBeNull();
  });

  it('spans the range of the dated events and counts the rest', () => {
    const band = layoutTimelineBand([
      entry(1, { dates: dates({ startDate: '1940-01-01', startPrecision: 'year' }) }),
      entry(2, { dates: dates({ startDate: '1944-01-01', startPrecision: 'year' }) }),
      entry(3),
    ]);

    expect(band).not.toBeNull();
    expect(band?.firstYear).toBe(1940);
    expect(band?.lastYear).toBe(1944);
    expect(band?.spans).toHaveLength(2);
    // The undated one is listed beneath the drawing, never silently dropped.
    expect(band?.undated).toBe(1);
  });

  it('gives a single-year chronology a drawable width', () => {
    const band = layoutTimelineBand([
      entry(1, { dates: dates({ startDate: '1943-01-01', startPrecision: 'year' }) }),
    ]);
    expect(band?.spans[0]?.width).toBeGreaterThan(0);
    expect(band?.ticks.length).toBeGreaterThan(0);
  });

  it('stacks overlapping events onto separate rows', () => {
    const band = layoutTimelineBand([
      entry(1, {
        dates: dates({
          startDate: '1940-01-01',
          startPrecision: 'year',
          endDate: '1945-01-01',
          endPrecision: 'year',
        }),
      }),
      entry(2, {
        dates: dates({
          startDate: '1941-01-01',
          startPrecision: 'year',
          endDate: '1944-01-01',
          endPrecision: 'year',
        }),
      }),
    ]);

    const rows = new Set(band?.spans.map((span) => span.y));
    expect(rows.size).toBe(2);
  });

  it('draws a bounded event across its whole window, marked uncertain', () => {
    const band = layoutTimelineBand([
      entry(1, {
        bounds: {
          after: [{ id: 9, title: 'A', href: '/events/a', dateLabel: '1941' }],
          before: [{ id: 8, title: 'B', href: '/events/b', dateLabel: '1944' }],
          earliest: '1941-06-29',
          latest: '1944-08-23',
        },
      }),
    ]);

    const span = band?.spans[0];
    // The window, not a point: the event is somewhere in there and the
    // sources do not say where.
    expect(span?.startYear).toBe(1941);
    expect(span?.endYear).toBe(1944);
    expect(span?.uncertain).toBe(true);
    expect(band?.undated).toBe(0);
  });

  it('marks a dated event as certain', () => {
    const band = layoutTimelineBand([
      entry(1, { dates: dates({ startDate: '1943-01-01', startPrecision: 'year' }) }),
    ]);
    expect(band?.spans[0]?.uncertain).toBe(false);
  });

  it('leaves an event with neither date nor bounds off the drawing', () => {
    const band = layoutTimelineBand([
      entry(1, { dates: dates({ startDate: '1943-01-01', startPrecision: 'year' }) }),
      entry(2),
    ]);
    expect(band?.spans).toHaveLength(1);
    expect(band?.undated).toBe(1);
  });

  it('carries the private flag through so the drawing can mark it', () => {
    const band = layoutTimelineBand([
      entry(1, {
        visibility: 'private',
        dates: dates({ startDate: '1943-01-01', startPrecision: 'year' }),
      }),
    ]);
    expect(band?.spans[0]?.visibility).toBe('private');
  });
});
