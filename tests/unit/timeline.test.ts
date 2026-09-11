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
  formatEventBounds,
  formatEventDate,
  instantOf,
  isCalendarDate,
  layoutTimelineBand,
  normaliseBoundary,
  parseSlugList,
  parseTimelineDirective,
  sortEntries,
  timelineDirectiveKey,
  type EventBoundAnchor,
  type BandLayout,
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

describe('instantOf', () => {
  it('reads a stored date and time as UTC, never as local', () => {
    // The suite runs in America/Anchorage on purpose. A slip to local time
    // would be nine hours out here and invisible on a UTC CI runner.
    expect(
      instantOf(
        dates({ startDate: '1943-06-02', startTime: '14:30', startPrecision: 'minute' }),
        'start',
      ),
    ).toBe(Date.UTC(1943, 5, 2, 14, 30));
  });

  it('places a two-digit year where it belongs, not in the twentieth century', () => {
    // `Date.UTC(42, 0, 1)` is 1942. This module must not be built on it.
    const instant = instantOf(dates({ startDate: '0042-01-01', startPrecision: 'year' }), 'start');
    expect(instant).not.toBeNull();
    expect(new Date(instant ?? 0).getUTCFullYear()).toBe(42);
  });

  it('refuses a date that is not on the calendar', () => {
    // MySQL under a permissive sql_mode can hold this, and one such row would
    // drag a chronology's axis back two millennia.
    expect(
      instantOf(dates({ startDate: '0000-00-00', startPrecision: 'day' }), 'start'),
    ).toBeNull();
    expect(
      instantOf(dates({ startDate: '1943-02-29', startPrecision: 'day' }), 'start'),
    ).toBeNull();
  });

  it('counts the clock only where the precision claims it', () => {
    const timed = dates({ startDate: '1943-06-02', startTime: '14:30', startPrecision: 'hour' });
    // At hour precision 14:30 means the 14:00 hour, exactly as it is printed.
    expect(instantOf(timed, 'start')).toBe(Date.UTC(1943, 5, 2, 14, 0));

    const untimed = dates({ startDate: '1943-06-02', startTime: '14:30', startPrecision: 'day' });
    expect(instantOf(untimed, 'start')).toBe(Date.UTC(1943, 5, 2));
  });

  it('closes a unit where the next one opens', () => {
    // Half-open, so adjacent units abut with no seam.
    expect(instantOf(dates({ startDate: '1943-06-02', startPrecision: 'year' }), 'end')).toBe(
      Date.UTC(1944, 0, 1),
    );
    expect(instantOf(dates({ startDate: '1943-06-02', startPrecision: 'decade' }), 'end')).toBe(
      Date.UTC(1950, 0, 1),
    );
  });

  it('claims no interval at all when the precision is unknown', () => {
    const unknown = dates({ startDate: '1943-06-02' });
    expect(instantOf(unknown, 'start')).toBe(Date.UTC(1943, 5, 2));
    // Not a day wide: `unknown` denies that the day is meaningful.
    expect(instantOf(unknown, 'end')).toBe(Date.UTC(1943, 5, 2));
  });

  it('falls back to the end when only that is known', () => {
    expect(instantOf(dates({ endDate: '1945-05-08', endPrecision: 'day' }), 'start')).toBe(
      Date.UTC(1945, 4, 8),
    );
  });

  it('is null for an undated event', () => {
    expect(instantOf(dates(), 'start')).toBeNull();
    expect(instantOf(dates(), 'end')).toBeNull();
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
  /** Where an instant falls on a laid-out band, from the module's own axis. */
  function xOf(band: BandLayout, instant: number): number {
    return ((instant - band.firstInstant) / (band.lastInstant - band.firstInstant)) * band.width;
  }

  function day(iso: string, id: number): TimelineEntry {
    return entry(id, { dates: dates({ startDate: iso, startPrecision: 'day' }) });
  }

  function year(value: number, id: number): TimelineEntry {
    return entry(id, { dates: dates({ startDate: `${value}-01-01`, startPrecision: 'year' }) });
  }

  it('is null when nothing can be placed', () => {
    expect(layoutTimelineBand([])).toBeNull();
    expect(layoutTimelineBand([entry(1)])).toBeNull();
  });

  it('captions the range the events cover and counts the rest', () => {
    const band = layoutTimelineBand([year(1940, 1), year(1944, 2), entry(3)]);

    expect(band).not.toBeNull();
    // Not "1940 to 1945": 1944 at year precision closes on 1 January 1945, and
    // the caption must not carry a date the record does not.
    expect(band?.rangeLabel).toBe('1940 to 1944');
    expect(band?.spans).toHaveLength(2);
    // The undated one is listed beneath the drawing, never silently dropped.
    expect(band?.undated).toBe(1);
    expect(band?.overflow).toBe(0);
  });

  it('captions a chronology inside one year as that year', () => {
    const band = layoutTimelineBand([day('1943-02-10', 1), day('1943-11-20', 2)]);
    expect(band?.rangeLabel).toBe('1943');
  });

  // --- The regressions this layout exists to fix ---------------------------

  it('spreads a chronology confined to a single year', () => {
    // The year-granular band drew both of these at x = 0.
    const band = layoutTimelineBand([day('1943-02-10', 1), day('1943-11-20', 2)]);
    const xs = band?.spans.map((span) => span.x) ?? [];
    expect(new Set(xs).size).toBe(2);
  });

  it('draws a multi-day event wider than a single day', () => {
    const band = layoutTimelineBand([
      entry(1, {
        dates: dates({
          startDate: '1941-06-29',
          startPrecision: 'day',
          endDate: '1941-07-06',
          endPrecision: 'day',
        }),
      }),
      day('1941-06-29', 2),
    ]);

    const pogrom = band?.spans.find((span) => span.id === 1);
    const oneDay = band?.spans.find((span) => span.id === 2);
    expect(pogrom?.width ?? 0).toBeGreaterThan((oneDay?.width ?? 0) * 10);
  });

  it('separates two events hours apart on the same day', () => {
    const band = layoutTimelineBand([
      entry(1, {
        dates: dates({ startDate: '1943-06-02', startTime: '09:00', startPrecision: 'hour' }),
      }),
      entry(2, {
        dates: dates({ startDate: '1943-06-02', startTime: '17:00', startPrecision: 'hour' }),
      }),
    ]);

    const morning = band?.spans.find((span) => span.id === 1);
    const evening = band?.spans.find((span) => span.id === 2);
    expect(evening?.x ?? 0).toBeGreaterThan((morning?.x ?? 0) + 100);
  });

  // --- Three marks, three meanings -----------------------------------------

  it('marks a recorded period, an instant and a window differently', () => {
    const band = layoutTimelineBand([
      entry(1, {
        dates: dates({
          startDate: '1940-01-01',
          startPrecision: 'year',
          endDate: '1945-01-01',
          endPrecision: 'year',
        }),
      }),
      year(1943, 2),
      entry(3, {
        bounds: { after: [], before: [], earliest: '1941-06-29', latest: '1944-08-23' },
      }),
    ]);

    const period = band?.spans.find((span) => span.id === 1);
    expect(period?.point).toBe(false);
    expect(period?.uncertain).toBe(false);

    const instant = band?.spans.find((span) => span.id === 2);
    expect(instant?.point).toBe(true);
    expect(instant?.uncertain).toBe(false);

    const window = band?.spans.find((span) => span.id === 3);
    expect(window?.point).toBe(false);
    expect(window?.uncertain).toBe(true);
  });

  it('gives a year-precision date no more width than a minute-precision one', () => {
    // The whole reason width means duration and nothing else: a year-wide bar
    // would assert a year-long event, which the record does not say.
    const band = layoutTimelineBand([
      year(1943, 1),
      entry(2, {
        dates: dates({ startDate: '1943-06-02', startTime: '14:30', startPrecision: 'minute' }),
      }),
    ]);
    const widths = band?.spans.map((span) => span.width) ?? [];
    expect(new Set(widths).size).toBe(1);
  });

  it('draws an unknown precision as a point, not as a day', () => {
    const band = layoutTimelineBand([entry(1, { dates: dates({ startDate: '1943-06-02' }) })]);
    const span = band?.spans[0];
    expect(span?.point).toBe(true);
    // Expanding it to exactly one day would assert that the day is meaningful,
    // which is precisely what `unknown` denies.
    expect(span?.endInstant).toBe(span?.startInstant);
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
    expect(span?.startInstant).toBe(Date.UTC(1941, 5, 29));
    expect(span?.endInstant).toBe(Date.UTC(1944, 7, 24));
    expect(span?.uncertain).toBe(true);
    expect(band?.undated).toBe(0);
  });

  // --- Degenerate input -----------------------------------------------------

  it('sets a lone event in the middle of the band', () => {
    // It sat at x = 0 before, hard against the edge, which looked like a bug.
    const band = layoutTimelineBand([year(1943, 1)]);
    expect(band?.spans[0]?.x).toBe(480);
    expect(band?.ticks.length).toBeGreaterThan(0);
  });

  it('survives every event sharing one instant', () => {
    const band = layoutTimelineBand([day('1943-06-02', 1), day('1943-06-02', 2)]);
    const xs = band?.spans.map((span) => span.x) ?? [];
    expect(new Set(xs).size).toBe(1);
    // Coincident bars must stack, or one would cover the other's link.
    expect(new Set(band?.spans.map((span) => span.y)).size).toBe(2);
  });

  it('survives a thousand-year span', () => {
    const band = layoutTimelineBand([year(1000, 1), year(2000, 2)]);
    expect(band?.spans).toHaveLength(2);
    expect(band?.ticks.length).toBeGreaterThan(1);
  });

  it('survives an end date before its start', () => {
    // The schema permits it, so the layout must not draw a negative width.
    const band = layoutTimelineBand([
      entry(1, {
        dates: dates({
          startDate: '1945-01-01',
          startPrecision: 'day',
          endDate: '1940-01-01',
          endPrecision: 'day',
        }),
      }),
    ]);
    expect(band?.spans[0]?.width ?? 0).toBeGreaterThan(0);
  });

  it('survives a same-day pair of times in the wrong order', () => {
    const band = layoutTimelineBand([
      entry(1, {
        dates: dates({
          startDate: '1943-06-02',
          startTime: '14:00',
          startPrecision: 'hour',
          endDate: '1943-06-02',
          endTime: '09:00',
          endPrecision: 'hour',
        }),
      }),
    ]);
    expect(band?.spans[0]?.width ?? 0).toBeGreaterThan(0);
  });

  it('falls back to the day when a precision claims a time the row lacks', () => {
    // What `formatEndpoint` already prints in that case; the drawing must not
    // disagree with the label beside it.
    const band = layoutTimelineBand([
      entry(1, { dates: dates({ startDate: '1943-06-02', startPrecision: 'minute' }) }),
    ]);
    expect(band?.spans[0]?.startInstant).toBe(Date.UTC(1943, 5, 2));
  });

  it('emits only finite coordinates', () => {
    const band = layoutTimelineBand([
      year(1000, 1),
      day('1943-06-02', 2),
      entry(3, { bounds: { after: [], before: [], earliest: '1941-06-29', latest: null } }),
      entry(4, { dates: dates({ startDate: '1943-06-02' }) }),
    ]);

    for (const span of band?.spans ?? []) {
      for (const value of [span.x, span.width, span.y]) expect(Number.isFinite(value)).toBe(true);
    }
    for (const tick of band?.ticks ?? []) expect(Number.isFinite(tick.x)).toBe(true);
  });

  // --- The axis -------------------------------------------------------------

  it('lands a year tick exactly on the first of January', () => {
    // Calendar iteration, not arithmetic on a nominal year: an approximated
    // year drifts by days, and the tick line then misses the bar it labels.
    const band = layoutTimelineBand([year(1940, 1), year(1944, 2)]);
    const tick = band?.ticks.find((candidate) => candidate.label === '1943');
    expect(tick).toBeDefined();
    expect(tick?.x).toBe(Math.round(xOf(band as BandLayout, Date.UTC(1943, 0, 1)) * 100) / 100);
  });

  it('re-qualifies a label when the year rolls over', () => {
    const band = layoutTimelineBand([day('1944-12-20', 1), day('1945-01-10', 2)]);
    const labels = band?.ticks.map((tick) => tick.label) ?? [];
    // "7 January" alone would be ambiguous across new year.
    expect(labels.some((label) => label.endsWith(' 1945'))).toBe(true);
    // ...and the ticks that need no qualifying stay short.
    expect(labels.some((label) => /^\d+ December$/.test(label))).toBe(true);
  });

  it('keeps the tick count readable at every scale', () => {
    const spans: readonly TimelineEntry[][] = [
      [
        entry(1, {
          dates: dates({ startDate: '1943-06-02', startTime: '14:00', startPrecision: 'minute' }),
        }),
        entry(2, {
          dates: dates({ startDate: '1943-06-02', startTime: '14:10', startPrecision: 'minute' }),
        }),
      ],
      [day('1943-06-02', 1), day('1943-06-05', 2)],
      [year(1940, 1), year(1944, 2)],
      [year(1900, 1), year(2000, 2)],
    ];

    for (const entries of spans) {
      const band = layoutTimelineBand(entries);
      expect(band?.ticks.length ?? 0).toBeGreaterThan(0);
      expect(band?.ticks.length ?? 0).toBeLessThanOrEqual(20);
    }
  });

  // --- Rows -----------------------------------------------------------------

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

  it('reports what would not fit rather than stacking it on another link', () => {
    // Overlapping bars let a covering <a> steal another event's tooltip and
    // click target: a reader could hover one bar and be shown a different
    // event's title.
    const crowd = Array.from({ length: 30 }, (_, index) => day('1943-06-02', index + 1));
    const band = layoutTimelineBand(crowd);

    expect(band?.spans).toHaveLength(24);
    expect(band?.overflow).toBe(6);
    expect(band?.undated).toBe(0);
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

  it('gives the template every coordinate it needs', () => {
    // The template prints what this module computed; it does no arithmetic of
    // its own on a height or a baseline.
    const band = layoutTimelineBand([year(1943, 1)]);
    expect(band?.viewBox).toBe(`0 ${band?.tickY} ${band?.width} ${band?.height}`);
    expect(band?.labelY ?? 0).toBeGreaterThan(band?.axisY ?? 0);
    // The baseline sits clear of the bottom edge, so descenders are not clipped.
    expect((band?.tickY ?? 0) + (band?.height ?? 0)).toBeGreaterThan(band?.labelY ?? 0);
  });
});
