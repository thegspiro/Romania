/**
 * Released government records, against a real database.
 *
 * What is pinned here is the part only MySQL can show: the record is written
 * in the source's own transaction, cleared when every field is blanked, left
 * alone by a caller that does not supply it, found by its identifiers, and
 * -- the invariant -- never found, filtered on or listed as a facet for a
 * viewer who may not see the source it belongs to.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import {
  createHarness,
  databaseAvailable,
  getPage,
  postForm,
  signIn,
  sourceForm,
  truncateContent,
  type Harness,
} from './helpers.js';
import { sourceInput } from './fixtures.js';
import { queryOne } from '../../src/db/pool.js';
import {
  createSource,
  findSourceById,
  listGovernmentFacets,
  listSources,
  updateSource,
} from '../../src/content/sources.js';
import {
  emptyGovernmentInput,
  type GovernmentRecordInput,
} from '../../src/content/government-records.js';
import { searchCorpus } from '../../src/content/search.js';
import { resolveForRender } from '../../src/content/render-context.js';
import {
  adminViewer,
  ANONYMOUS,
  type Viewer,
  type Visibility,
} from '../../src/content/visibility.js';

const available = await databaseAvailable();

const CREST = 'CIA-RDP82-00457R000400330004-2';

function government(overrides: Partial<GovernmentRecordInput> = {}): GovernmentRecordInput {
  return { ...emptyGovernmentInput(), ...overrides };
}

describe.skipIf(!available)('government records', () => {
  let harness: Harness;
  const admin = adminViewer(1);

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
  });

  async function makeRecord(
    title: string,
    visibility: Visibility,
    record: Partial<GovernmentRecordInput>,
  ): Promise<number> {
    return createSource(
      harness.pool,
      sourceInput({
        title,
        visibility,
        cslType: 'manuscript',
        authors: 'American Legation, Bucharest',
        publisher: '',
        publisherPlace: '',
        issued: '1947-03-12',
        government: government(record),
      }),
    );
  }

  async function rowCount(id: number): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      harness.pool,
      'SELECT COUNT(*) AS total FROM source_government_record WHERE content_item_id = ?',
      [id],
    );
    return Number(row?.total ?? 0);
  }

  it('stores the record with the source and reads it back', async () => {
    const id = await makeRecord('Situation in Romania', 'private', {
      originatingAgency: 'Department of State',
      documentType: 'Telegram',
      cableNumber: '312',
      naraRecordGroup: '59',
      naraBox: '6662',
      declassifiedOn: '1998-04-02',
    });

    const source = await findSourceById(harness.pool, id, admin);
    expect(source?.government).toMatchObject({
      originatingAgency: 'Department of State',
      documentType: 'Telegram',
      cableNumber: '312',
      crestNumber: null,
      declassifiedOn: '1998-04-02',
    });
    // The stored CSL is untouched; only the citable one is filled.
    expect(source?.csl.genre).toBeUndefined();
    expect(source?.citableCsl.genre).toBe('Telegram');
    expect(source?.citableCsl.number).toBe('312');
    expect(source?.citableCsl.archive_location).toBe('RG 59, box 6662');
  });

  it('creates no row for an ordinary source', async () => {
    const id = await createSource(
      harness.pool,
      sourceInput({ title: 'A Book', government: emptyGovernmentInput() }),
    );
    expect(await rowCount(id)).toBe(0);
    expect((await findSourceById(harness.pool, id, admin))?.government).toBeNull();
  });

  it('removes the row when every field is blanked', async () => {
    const id = await makeRecord('Situation in Romania', 'private', { crestNumber: CREST });
    expect(await rowCount(id)).toBe(1);

    await updateSource(harness.pool, id, sourceInput({ government: emptyGovernmentInput() }));
    expect(await rowCount(id)).toBe(0);
  });

  it('leaves the row alone when a caller does not supply it', async () => {
    const id = await makeRecord('Situation in Romania', 'private', { crestNumber: CREST });

    await updateSource(harness.pool, id, sourceInput({ title: 'Renamed' }));
    expect((await findSourceById(harness.pool, id, admin))?.government?.crestNumber).toBe(CREST);
  });

  it('is deleted with its source', async () => {
    const id = await makeRecord('Situation in Romania', 'private', { crestNumber: CREST });
    await harness.pool.query('DELETE FROM content_item WHERE id = ?', [id]);
    expect(await rowCount(id)).toBe(0);
  });

  it('finds a source by a pasted identifier, in the listing and corpus-wide', async () => {
    const id = await makeRecord('Situation in Romania', 'public', {
      crestNumber: CREST,
      foiaCaseNumber: 'F-2019-01234',
    });

    const listed = await listSources(harness.pool, admin, { search: CREST });
    expect(listed.items.map((item) => item.id)).toEqual([id]);

    const byFoia = await listSources(harness.pool, ANONYMOUS, { search: 'F-2019-01234' });
    expect(byFoia.items.map((item) => item.id)).toEqual([id]);

    const corpus = await searchCorpus(harness.pool, admin, CREST);
    expect(corpus.hits.map((hit) => hit.id)).toEqual([id]);
  });

  it('never surfaces a private record by its identifiers', async () => {
    await makeRecord('Secret Cable', 'private', {
      crestNumber: CREST,
      originatingAgency: 'Central Intelligence Agency',
    });

    expect((await listSources(harness.pool, ANONYMOUS, { search: CREST })).total).toBe(0);
    expect((await searchCorpus(harness.pool, ANONYMOUS, CREST)).total).toBe(0);
    expect((await listGovernmentFacets(harness.pool, ANONYMOUS)).agencies).toEqual([]);
    expect((await listGovernmentFacets(harness.pool, admin)).agencies).toEqual([
      'Central Intelligence Agency',
    ]);
  });

  it('filters by agency, classification and collection for an administrator only', async () => {
    const cia = await makeRecord('A Report', 'public', {
      originatingAgency: 'Central Intelligence Agency',
      originalClassification: 'SECRET',
      releaseCollection: 'CIA Electronic Reading Room',
    });
    const state = await makeRecord('A Telegram', 'public', {
      originatingAgency: 'Department of State',
      originalClassification: 'CONFIDENTIAL',
    });

    const ids = async (viewer: Viewer, filter: object): Promise<number[]> =>
      (await listSources(harness.pool, viewer, filter)).items.map((item) => item.id).sort();

    expect(await ids(admin, { agency: 'Central Intelligence Agency' })).toEqual([cia]);
    expect(await ids(admin, { classification: 'CONFIDENTIAL' })).toEqual([state]);
    expect(await ids(admin, { collection: 'CIA Electronic Reading Room' })).toEqual([cia]);
    // Ignored for a visitor, exactly like ?visibility=.
    expect(await ids(ANONYMOUS, { agency: 'Central Intelligence Agency' })).toEqual(
      [cia, state].sort(),
    );
  });

  it('fills a footnote in prose from the record', async () => {
    const id = await makeRecord('Situation in Romania', 'public', {
      documentType: 'Telegram',
      cableNumber: '312',
    });
    const source = await findSourceById(harness.pool, id, admin);

    const targets = await resolveForRender(
      harness.pool,
      `[[cite:${source?.slug ?? ''}]]`,
      ANONYMOUS,
    );
    const target = [...targets.values()][0];
    expect(target?.csl?.genre).toBe('Telegram');
    expect(target?.csl?.number).toBe('312');
  });

  describe('through the admin form', () => {
    let jar: Map<string, string>;

    beforeEach(async () => {
      jar = await signIn(harness);
    });

    it('saves the fields and shows them in the editor', async () => {
      const page = await getPage(harness, '/admin/sources/new', jar);
      const result = await postForm(harness, '/admin/sources', jar, {
        ...sourceForm({ title: 'Situation in Romania', cslType: 'manuscript' }),
        _csrf: page.csrf,
        crestNumber: CREST,
        originatingAgency: 'Central Intelligence Agency',
        releasedOn: '2001-03-04',
      });
      const id = /\/admin\/sources\/(\d+)\/edit/.exec(result.location ?? '')?.[1];
      expect(id).toBeDefined();

      const edit = await getPage(harness, `/admin/sources/${id ?? ''}/edit`, jar);
      expect(edit.body).toContain(`value="${CREST}"`);
      expect(edit.body).toContain('value="2001-03-04"');

      const listing = await getPage(harness, '/admin/sources', jar);
      expect(listing.body).toContain('<option value="Central Intelligence Agency"');
    });

    it('rejects a partial release date rather than guessing a day', async () => {
      const page = await getPage(harness, '/admin/sources/new', jar);
      const result = await postForm(harness, '/admin/sources', jar, {
        ...sourceForm({ title: 'Situation in Romania' }),
        _csrf: page.csrf,
        releasedOn: '2001',
      });
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('Release date must be a full date');
      // The typed value survives the round trip so it can be corrected.
      expect(result.body).toContain('value="2001"');
    });
  });
});
