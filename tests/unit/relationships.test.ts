/**
 * Role and period rendering.
 *
 * These are pure functions over the qualifying fields an edge may carry, so
 * they are unit-tested here; the SQL that stores and filters on those fields
 * is exercised against a real database in tests/integration/relationships.
 *
 * The precision contract is the one `event_detail` already uses: a date stored
 * as 1944-01-01 with precision 'year' means "1944", not "1 January 1944".
 * Rendering more than the precision claims would put a false exactness into a
 * dissertation's own notes.
 */
import { describe, expect, it } from 'vitest';
import {
  LINKABLE_KINDS,
  columnToIsoDate,
  edgeLabel,
  formatPeriod,
  isLinkableKind,
  isPeriodPrecision,
  isoDate,
  parsePredicateChoice,
  type PeriodPrecision,
} from '../../src/content/relationships.js';

function period(startDate: string | null, endDate: string | null, precision: PeriodPrecision) {
  return formatPeriod({ startDate, endDate, precision });
}

describe('formatPeriod', () => {
  it('returns null when neither end is known', () => {
    // The caller omits the whole fragment rather than printing an empty range.
    expect(period(null, null, 'year')).toBeNull();
    expect(period(null, null, 'unknown')).toBeNull();
  });

  it('renders a closed range to year precision', () => {
    expect(period('1940-09-06', '1944-08-23', 'year')).toBe('1940–1944');
  });

  it('renders a closed range to month precision', () => {
    expect(period('1940-09-06', '1941-01-21', 'month')).toBe('September 1940 – January 1941');
  });

  it('renders a closed range to day precision', () => {
    expect(period('1940-09-06', '1944-08-23', 'day')).toBe('6 September 1940 – 23 August 1944');
  });

  it('renders a decade from the year of the stored date', () => {
    expect(period('1937-04-01', null, 'decade')).toBe('from the 1930s');
    expect(period('1937-04-01', '1948-01-01', 'decade')).toBe('1930s–1940s');
  });

  it('claims only the year when the precision is unknown', () => {
    // 'unknown' means the exactness of the stored value is not established,
    // so the year is the most that can honestly be printed.
    expect(period('1940-09-06', null, 'unknown')).toBe('from 1940');
  });

  it('renders an open start and an open end differently', () => {
    expect(period('1940-01-01', null, 'year')).toBe('from 1940');
    expect(period(null, '1944-01-01', 'year')).toBe('until 1944');
  });

  it('collapses a range whose ends render identically', () => {
    // Two dates within one year at year precision are one year, not "1940–1940".
    expect(period('1940-01-05', '1940-11-30', 'year')).toBe('1940');
  });

  it('spaces the dash only when an endpoint contains a space', () => {
    expect(period('1940-01-01', '1944-01-01', 'year')).not.toContain(' – ');
    expect(period('1940-01-01', '1944-03-01', 'month')).toContain(' – ');
  });
});

describe('edgeLabel', () => {
  it('uses the predicate when no role was recorded', () => {
    expect(edgeLabel('Member of', null, null)).toBe('Member of');
  });

  it('lets the role take the headline when there is one', () => {
    // "Prime Minister, 1941–1944" says more than "Held office in".
    expect(edgeLabel('Held office in', 'Prime Minister', '1941–1944')).toBe(
      'Prime Minister, 1941–1944',
    );
  });

  it('treats an empty role as no role', () => {
    expect(edgeLabel('Member of', '', '1940')).toBe('Member of, 1940');
  });

  it('appends the period to a bare predicate', () => {
    expect(edgeLabel('Member of', null, '1940–1941')).toBe('Member of, 1940–1941');
  });
});

describe('isoDate', () => {
  it('accepts only a full calendar date', () => {
    expect(isoDate('1940-09-06')).toBe('1940-09-06');
    expect(isoDate('  1940-09-06  ')).toBe('1940-09-06');
  });

  it('rejects anything the DATE column could not hold', () => {
    for (const value of ['1940', '1940-09', '06/09/1940', 'yesterday', '', null, undefined]) {
      expect(isoDate(value)).toBeNull();
    }
  });
});

describe('columnToIsoDate', () => {
  it('reads a DATE column back as an ISO date', () => {
    // mysql2 hands back a Date built at UTC midnight, because the pool sets
    // `timezone: 'Z'`. String(date).slice(0, 10) would give "Fri Sep 06".
    expect(columnToIsoDate(new Date('1940-09-06T00:00:00.000Z'))).toBe('1940-09-06');
  });

  it('accepts a driver configured to return strings', () => {
    expect(columnToIsoDate('1940-09-06')).toBe('1940-09-06');
    expect(columnToIsoDate('1940-09-06T00:00:00.000Z')).toBe('1940-09-06');
  });

  it('reads a missing date as null', () => {
    expect(columnToIsoDate(null)).toBeNull();
    expect(columnToIsoDate(undefined)).toBeNull();
    expect(columnToIsoDate('not a date')).toBeNull();
  });
});

describe('isPeriodPrecision', () => {
  it('accepts exactly the enum the column declares', () => {
    for (const value of ['day', 'month', 'year', 'decade', 'unknown']) {
      expect(isPeriodPrecision(value)).toBe(true);
    }
  });

  it('rejects anything else, including near misses', () => {
    for (const value of ['days', 'Year', '', null, 1, undefined]) {
      expect(isPeriodPrecision(value)).toBe(false);
    }
  });
});

describe('isLinkableKind', () => {
  it('accepts the four entity kinds and artifacts', () => {
    for (const kind of LINKABLE_KINDS) expect(isLinkableKind(kind)).toBe(true);
    expect(LINKABLE_KINDS).toContain('artifact');
  });

  it('refuses a source, whose authorship is already its CSL record', () => {
    // A created_by edge beside the CSL author list would be a second answer
    // to "who wrote this".
    expect(isLinkableKind('source')).toBe(false);
  });

  it('refuses an essay, whose connections are projected from its prose', () => {
    // `mention` rows are rebuilt from the text by rebuildReferences and
    // written by nothing else; a hand-asserted edge would be the hand-edited
    // projection this application refuses to keep.
    expect(isLinkableKind('essay')).toBe(false);
  });

  it('refuses anything that is not a kind at all', () => {
    expect(isLinkableKind('manuscript')).toBe(false);
    expect(isLinkableKind('')).toBe(false);
    expect(isLinkableKind(7)).toBe(false);
    expect(isLinkableKind(null)).toBe(false);
    expect(isLinkableKind(undefined)).toBe(false);
  });
});

describe('parsePredicateChoice', () => {
  it('reads both directions', () => {
    expect(parsePredicateChoice('12:forward')).toEqual({ predicateId: 12, reverse: false });
    expect(parsePredicateChoice('12:reverse')).toEqual({ predicateId: 12, reverse: true });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePredicateChoice('  3:reverse  ')).toEqual({ predicateId: 3, reverse: true });
  });

  it('refuses a direction that does not exist', () => {
    // A hand-edited form must not be able to name a third reading.
    expect(parsePredicateChoice('12:sideways')).toBeNull();
    expect(parsePredicateChoice('12')).toBeNull();
    expect(parsePredicateChoice('12:')).toBeNull();
  });

  it('refuses anything that is not a predicate id', () => {
    expect(parsePredicateChoice('0:forward')).toBeNull();
    expect(parsePredicateChoice('-1:forward')).toBeNull();
    expect(parsePredicateChoice('1e3:forward')).toBeNull();
    expect(parsePredicateChoice('9999999999:forward')).toBeNull();
    expect(parsePredicateChoice('')).toBeNull();
    expect(parsePredicateChoice(null)).toBeNull();
    expect(parsePredicateChoice(42)).toBeNull();
  });
});
