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
  eventEndYear,
  eventYear,
  formatEventDate,
  layoutTimelineBand,
  normaliseBoundary,
  parseTimelineDirective,
  sortEntries,
  timelineDirectiveKey,
  type EventDates,
  type TimelineEntry,
} from '../../src/content/timeline.js';

function dates(overrides: Partial<EventDates> = {}): EventDates {
  return {
    startDate: null,
    endDate: null,
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
