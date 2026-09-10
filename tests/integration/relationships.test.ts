/**
 * Roles, positions and periods on a relationship edge.
 *
 * Against a real MySQL, because the properties being asserted live in the
 * schema rather than in TypeScript: the widened unique key, the generated
 * `period_key` that folds NULL to the empty string, and the check constraints
 * on the date range and the role title.
 *
 * The visibility rule is asserted here too. An office is often the most
 * sensitive thing recorded about a person, and it rides on an edge that
 * already has its own visibility column; a leak would be a leak of the whole
 * claim, not just of a date.
 *
 * Requires MySQL. Without one the suite skips rather than fails; check the
 * output before believing a green run covered this.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, databaseAvailable, truncateContent, type Harness } from './helpers.js';
import { makeEntity } from './fixtures.js';
import {
  createRelationship,
  listPredicates,
  listRelationshipsFor,
  type Predicate,
} from '../../src/content/relationships.js';
import { ANONYMOUS, adminViewer } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('relationship roles and periods', () => {
  let harness: Harness;
  let admin: ReturnType<typeof adminViewer>;
  let predicates: Predicate[];
  let heldOffice: number;
  let memberOf: number;

  function predicateId(code: string): number {
    const found = predicates.find((predicate) => predicate.code === code);
    if (found === undefined) throw new Error(`no seeded predicate "${code}"`);
    return found.id;
  }

  beforeAll(async () => {
    harness = await createHarness();
    admin = adminViewer(harness.userId);
    predicates = await listPredicates(harness.pool);
    heldOffice = predicateId('held_office_in');
    memberOf = predicateId('member_of');
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
  });

  /** A person and an organization, both public. */
  async function pair(): Promise<{ person: number; org: number }> {
    return {
      person: await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public'),
      org: await makeEntity(harness.pool, 'organization', 'Council of Ministers', 'public'),
    };
  }

  describe('the vocabulary', () => {
    it('seeds the office-holding predicates', () => {
      const codes = predicates.map((predicate) => predicate.code);
      expect(codes).toContain('held_office_in');
      expect(codes).toContain('commanded');
      expect(codes).toContain('reported_to');
    });

    it('reads an office predicate correctly from the other end', () => {
      const found = predicates.find((predicate) => predicate.code === 'held_office_in');
      expect(found?.label).toBe('Held office in');
      expect(found?.inverseLabel).toBe('Office held by');
    });
  });

  describe('recording an office', () => {
    it('stores the role and the period on the edge', async () => {
      const { person, org } = await pair();

      const outcome = await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'President of the Council of Ministers',
        startDate: '1940-09-06',
        endDate: '1944-08-23',
        datePrecision: 'day',
        note: null,
        visibility: 'public',
      });
      expect(outcome.ok).toBe(true);

      const [edge] = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(edge?.roleTitle).toBe('President of the Council of Ministers');
      expect(edge?.period.startDate).toBe('1940-09-06');
      expect(edge?.period.endDate).toBe('1944-08-23');
      expect(edge?.period.precision).toBe('day');
      expect(edge?.periodLabel).toBe('6 September 1940 – 23 August 1944');
    });

    it('reads the date back as the day it was stored, not shifted by a zone', async () => {
      // A DATE column arrives as a Date at UTC midnight. Reading it with
      // String(...).slice(0, 10) would produce "Fri Sep 06" instead.
      const { person, org } = await pair();
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Minister',
        startDate: '1940-09-06',
        endDate: null,
        datePrecision: 'day',
        note: null,
        visibility: 'public',
      });

      const [edge] = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(edge?.period.startDate).toBe('1940-09-06');
    });

    it('lets the role take the headline in the display label', async () => {
      const { person, org } = await pair();
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Prime Minister',
        startDate: '1941-01-01',
        endDate: '1944-01-01',
        datePrecision: 'year',
        note: null,
        visibility: 'public',
      });

      const [edge] = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(edge?.display).toBe('Prime Minister, 1941–1944');
    });

    it('keeps an unqualified edge exactly as it was', async () => {
      // The whole point of folding NULL to '' in period_key: an edge with no
      // office and no dates must behave the way it did before this existed.
      const { person, org } = await pair();
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: memberOf,
        note: null,
        visibility: 'public',
      });

      const [edge] = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(edge?.roleTitle).toBeNull();
      expect(edge?.periodLabel).toBeNull();
      expect(edge?.display).toBe('Member of');
    });
  });

  describe('what counts as the same edge', () => {
    it('accepts two offices at the same organization', async () => {
      // The reason the unique key had to widen: a career is a sequence of
      // posts at one institution, not one post.
      const { person, org } = await pair();

      for (const [role, from, to] of [
        ['Minister of Defence', '1937-01-01', '1938-01-01'],
        ['President of the Council of Ministers', '1940-01-01', '1944-01-01'],
      ] as const) {
        const outcome = await createRelationship(harness.pool, {
          fromItemId: person,
          toItemId: org,
          predicateId: heldOffice,
          roleTitle: role,
          startDate: from,
          endDate: to,
          datePrecision: 'year',
          note: null,
          visibility: 'public',
        });
        expect(outcome.ok).toBe(true);
      }

      const edges = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(edges).toHaveLength(2);
      // Earliest first, so a career reads in sequence.
      expect(edges.map((edge) => edge.roleTitle)).toEqual([
        'Minister of Defence',
        'President of the Council of Ministers',
      ]);
    });

    it('accepts the same office held twice in different periods', async () => {
      const { person, org } = await pair();
      const base = {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Chief of Staff',
        datePrecision: 'year' as const,
        note: null,
        visibility: 'public' as const,
      };

      expect(
        (
          await createRelationship(harness.pool, {
            ...base,
            startDate: '1934-01-01',
            endDate: null,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await createRelationship(harness.pool, {
            ...base,
            startDate: '1941-01-01',
            endDate: null,
          })
        ).ok,
      ).toBe(true);
    });

    it('still refuses an exact duplicate', async () => {
      const { person, org } = await pair();
      const input = {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Minister',
        startDate: '1940-01-01',
        endDate: '1941-01-01',
        datePrecision: 'year' as const,
        note: null,
        visibility: 'public' as const,
      };

      expect((await createRelationship(harness.pool, input)).ok).toBe(true);
      const second = await createRelationship(harness.pool, input);
      expect(second).toEqual({ ok: false, reason: 'duplicate' });
    });

    it('still refuses a duplicate that qualifies nothing', async () => {
      // MySQL treats NULLs as distinct in a unique index, so without the
      // generated key this is the case that would silently start passing.
      const { person, org } = await pair();
      const input = {
        fromItemId: person,
        toItemId: org,
        predicateId: memberOf,
        note: null,
        visibility: 'public' as const,
      };

      expect((await createRelationship(harness.pool, input)).ok).toBe(true);
      expect(await createRelationship(harness.pool, input)).toEqual({
        ok: false,
        reason: 'duplicate',
      });
    });
  });

  describe('normalising what the form sends', () => {
    it('reads a blank or whitespace role as no role', async () => {
      const { person, org } = await pair();
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: memberOf,
        roleTitle: '   ',
        note: null,
        visibility: 'public',
      });

      const [edge] = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(edge?.roleTitle).toBeNull();
    });

    it('reads a malformed date as no date rather than failing the save', async () => {
      const { person, org } = await pair();
      const outcome = await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: memberOf,
        startDate: 'sometime in 1940',
        endDate: '1941',
        datePrecision: 'year',
        note: null,
        visibility: 'public',
      });
      expect(outcome.ok).toBe(true);

      const [edge] = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(edge?.period.startDate).toBeNull();
      expect(edge?.period.endDate).toBeNull();
    });

    it('swaps a reversed range instead of tripping the check constraint', async () => {
      const { person, org } = await pair();
      const outcome = await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: memberOf,
        startDate: '1944-01-01',
        endDate: '1940-01-01',
        datePrecision: 'year',
        note: null,
        visibility: 'public',
      });
      expect(outcome.ok).toBe(true);

      const [edge] = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(edge?.period.startDate).toBe('1940-01-01');
      expect(edge?.period.endDate).toBe('1944-01-01');
    });

    it('refuses an over-long role rather than truncating it', async () => {
      // Truncating an office would misstate the record silently, which is
      // worse than refusing the save.
      const { person, org } = await pair();
      const outcome = await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'x'.repeat(256),
        note: null,
        visibility: 'public',
      });
      expect(outcome).toEqual({ ok: false, reason: 'role_too_long' });

      expect(await listRelationshipsFor(harness.pool, person, admin)).toEqual([]);
    });

    it('reads an unknown precision as "unknown"', async () => {
      const { person, org } = await pair();
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: memberOf,
        startDate: '1940-01-01',
        endDate: null,
        note: null,
        visibility: 'public',
      });

      const [edge] = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(edge?.period.precision).toBe('unknown');
      expect(edge?.periodLabel).toBe('from 1940');
    });
  });

  describe('the visibility rule still holds over the qualifier', () => {
    it('withholds the office when the edge itself is private', async () => {
      const { person, org } = await pair();
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Head of the Secret Police',
        startDate: '1940-01-01',
        endDate: null,
        datePrecision: 'year',
        note: null,
        visibility: 'private',
      });

      const anonymous = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(anonymous).toEqual([]);
      expect(JSON.stringify(anonymous)).not.toContain('Secret Police');

      const asAdmin = await listRelationshipsFor(harness.pool, person, admin);
      expect(asAdmin).toHaveLength(1);
      expect(asAdmin[0]?.roleTitle).toBe('Head of the Secret Police');
    });

    it('withholds a public office whose other end is private', async () => {
      // The edge is public, but naming the office would disclose that the
      // organization exists -- which is the disclosure, not the date.
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      const org = await makeEntity(harness.pool, 'organization', 'Unnamed Bureau', 'private');
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Director',
        startDate: '1940-01-01',
        endDate: null,
        datePrecision: 'year',
        note: null,
        visibility: 'public',
      });

      const anonymous = await listRelationshipsFor(harness.pool, person, ANONYMOUS);
      expect(anonymous).toEqual([]);
      expect(JSON.stringify(anonymous)).not.toContain('Unnamed Bureau');
      expect(JSON.stringify(anonymous)).not.toContain('Director');

      expect(await listRelationshipsFor(harness.pool, person, admin)).toHaveLength(1);
    });

    it('reads the office from the other end with the inverse label', async () => {
      const { person, org } = await pair();
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Prime Minister',
        startDate: '1941-01-01',
        endDate: null,
        datePrecision: 'year',
        note: null,
        visibility: 'public',
      });

      const [fromOrg] = await listRelationshipsFor(harness.pool, org, ANONYMOUS);
      expect(fromOrg?.inverted).toBe(true);
      expect(fromOrg?.label).toBe('Office held by');
      expect(fromOrg?.roleTitle).toBe('Prime Minister');
      expect(fromOrg?.other.title).toBe('Ion Antonescu');
    });
  });

  describe('the entity page', () => {
    it('shows the office and period as text, with no markup from the operator', async () => {
      const { person, org } = await pair();
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Minister <script>alert(1)</script>',
        startDate: '1940-01-01',
        endDate: '1944-01-01',
        datePrecision: 'year',
        note: null,
        visibility: 'public',
      });

      const page = await harness.app.inject({ method: 'GET', url: '/people/ion-antonescu' });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('1940–1944');
      // Autoescape, never `| safe`: the operator types this field.
      expect(page.body).not.toContain('<script>alert(1)</script>');
      expect(page.body).toContain('&lt;script&gt;');
    });

    it('leaks nothing about a private office to an anonymous reader', async () => {
      const { person, org } = await pair();
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Head of the Secret Police',
        startDate: '1940-01-01',
        endDate: '1944-01-01',
        datePrecision: 'year',
        note: null,
        visibility: 'private',
      });

      const page = await harness.app.inject({ method: 'GET', url: '/people/ion-antonescu' });
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('Secret Police');
      expect(page.body).not.toContain('1940–1944');
      // No gap, no placeholder: the absence is indistinguishable from never
      // having existed.
      expect(page.body).not.toContain('withheld');
    });
  });
});
