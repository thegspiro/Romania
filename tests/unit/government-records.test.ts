import { describe, expect, it } from 'vitest';
import {
  citableCsl,
  emptyGovernmentInput,
  naraLocation,
  parseCalendarDay,
  readGovernmentForm,
  type GovernmentRecord,
} from '../../src/content/government-records.js';
import { renderBibliographyEntry, renderNote } from '../../src/citations/render.js';
import type { CslItem } from '../../src/citations/csl.js';

function record(overrides: Partial<GovernmentRecord> = {}): GovernmentRecord {
  const blank = {} as GovernmentRecord;
  for (const key of Object.keys(emptyGovernmentInput()) as (keyof GovernmentRecord)[]) {
    blank[key] = null;
  }
  return { ...blank, ...overrides };
}

const TELEGRAM: CslItem = {
  id: 'situation-in-romania',
  type: 'manuscript',
  title: 'Situation in Romania',
  author: [{ literal: 'American Legation, Bucharest' }],
  issued: { 'date-parts': [[1947, 3, 12]] },
};

describe('citableCsl', () => {
  it('returns the stored item unchanged for an ordinary source', () => {
    expect(citableCsl(TELEGRAM, null)).toBe(TELEGRAM);
  });

  it('fills blank CSL variables from the record', () => {
    const item = citableCsl(
      TELEGRAM,
      record({
        documentType: 'Telegram',
        cableNumber: '312',
        naraRecordGroup: '59',
        naraEntry: '205',
        naraBox: '6662',
        releaseCollection: 'State Department FOIA Virtual Reading Room',
      }),
    );
    expect(item).toMatchObject({
      genre: 'Telegram',
      number: '312',
      archive_location: 'RG 59, entry 205, box 6662',
      archive: 'State Department FOIA Virtual Reading Room',
    });
  });

  it('never overrides a value the stored record already has', () => {
    const stored: CslItem = {
      ...TELEGRAM,
      genre: 'Airgram',
      archive: 'National Archives and Records Administration',
    };
    const item = citableCsl(
      stored,
      record({ documentType: 'Telegram', releaseCollection: 'CIA Electronic Reading Room' }),
    );
    expect(item.genre).toBe('Airgram');
    expect(item.archive).toBe('National Archives and Records Administration');
  });

  it('does not mutate the stored item', () => {
    const stored: CslItem = { ...TELEGRAM };
    citableCsl(stored, record({ documentType: 'Telegram' }));
    expect(stored.genre).toBeUndefined();
  });

  it('prefers the cable number and falls back to the CREST number', () => {
    const crest = 'CIA-RDP82-00457R000400330004-2';
    expect(citableCsl(TELEGRAM, record({ crestNumber: crest })).number).toBe(crest);
    expect(citableCsl(TELEGRAM, record({ cableNumber: '312', crestNumber: crest })).number).toBe(
      '312',
    );
  });

  it('leaves FRUS identifiers out of the citation', () => {
    const item = citableCsl(
      TELEGRAM,
      record({ frusVolume: '1947, Volume IV', frusDocumentNumber: '12' }),
    );
    expect(item).toEqual(TELEGRAM);
  });

  it('renders a Chicago note and bibliography entry through citeproc', () => {
    const item = citableCsl(
      TELEGRAM,
      record({
        documentType: 'Telegram',
        cableNumber: '312',
        naraRecordGroup: '59',
        naraBox: '6662',
      }),
    );
    item.archive = 'National Archives and Records Administration';

    expect(renderNote(item)).toBe(
      'American Legation, Bucharest, “Situation in Romania,” Telegram no. 312, March 12, 1947, ' +
        'RG 59, box 6662, National Archives and Records Administration.',
    );
    expect(renderBibliographyEntry(item)).toContain('Telegram No. 312.');
  });
});

describe('naraLocation', () => {
  it('joins whichever parts are present', () => {
    expect(naraLocation(record({ naraRecordGroup: '263', naraFolder: 'Romania' }))).toBe(
      'RG 263, folder Romania',
    );
  });

  it('is null when nothing is recorded', () => {
    expect(naraLocation(record())).toBeNull();
  });
});

describe('parseCalendarDay', () => {
  it('accepts a full date', () => {
    expect(parseCalendarDay('2001-03-04')).toBe('2001-03-04');
  });

  it.each(['2001', '2001-03', '04/03/2001', '1998-02-31', ''])('rejects %j', (value) => {
    expect(parseCalendarDay(value)).toBeNull();
  });
});

describe('readGovernmentForm', () => {
  const reader =
    (fields: Record<string, string>) =>
    (name: string): string =>
      fields[name] ?? '';

  it('trims every field', () => {
    const { input, errors } = readGovernmentForm(reader({ crestNumber: '  CIA-RDP1  ' }));
    expect(errors).toEqual([]);
    expect(input.crestNumber).toBe('CIA-RDP1');
  });

  it('reports a partial date and an over-long value', () => {
    const { errors } = readGovernmentForm(
      reader({ declassifiedOn: '1998', naraBox: 'x'.repeat(51) }),
    );
    expect(errors).toEqual([
      'NARA box is too long (50 characters maximum).',
      'Declassification date must be a full date, YYYY-MM-DD.',
    ]);
  });
});
