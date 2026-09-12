/**
 * The relational view: entity pages, backlinks and the network graph.
 *
 * Two invariants from CLAUDE.md are exercised end to end over rendered pages
 * rather than over repository functions, because that is where a leak would
 * actually reach a reader:
 *
 *  1. A private item is 404, never 403.
 *  2. A public page never leaks a private reference -- not its title, not its
 *     slug, not its id; it renders as plain text, not a link.
 *
 * The graph adds a third: a private node is never traversed *through*, so the
 * shape of the drawing cannot betray one sitting between two public nodes.
 *
 * Requires MySQL. Without one the suite skips rather than fails; check the
 * output before believing a green run covered this.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createHarness,
  csrfFrom,
  databaseAvailable,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { makeEntity, makeEssay, makeSource } from './fixtures.js';
import { buildGraph, type Graph } from '../../src/content/graph.js';
import {
  createRelationship,
  listPredicates,
  type Predicate,
} from '../../src/content/relationships.js';
import { findEntityById } from '../../src/content/entities.js';
import { ANONYMOUS, adminViewer } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('relational browsing', () => {
  let harness: Harness;
  let admin: ReturnType<typeof adminViewer>;
  let associatedWith: number;
  let heldOffice: number;
  let predicates: Predicate[];

  beforeAll(async () => {
    harness = await createHarness();
    admin = adminViewer(harness.userId);
    predicates = await listPredicates(harness.pool);
    associatedWith = predicates.find((predicate) => predicate.code === 'associated_with')!.id;
    heldOffice = predicates.find((predicate) => predicate.code === 'held_office_in')!.id;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
  });

  describe('entity pages', () => {
    it('lists a public essay as a mention, with its context sentence', async () => {
      await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      await makeEssay(
        harness.pool,
        'Report on the Commission',
        'public',
        'The commission met in July. [[person:ion-antonescu|The Marshal]] presided over it.',
      );

      const page = await harness.app.inject({ method: 'GET', url: '/people/ion-antonescu' });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Report on the Commission');
      expect(page.body).toContain('/essays/report-on-the-commission');
      expect(page.body).toContain('The Marshal presided over it.');
    });

    it('does not show a private essay on a public person page', async () => {
      await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      await makeEssay(
        harness.pool,
        'Unpublished Chapter',
        'private',
        'A confidential finding about [[person:ion-antonescu]].',
      );

      const anonymous = await harness.app.inject({ method: 'GET', url: '/people/ion-antonescu' });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.body).not.toContain('Unpublished');
      expect(anonymous.body).not.toContain('unpublished-chapter');
      expect(anonymous.body).not.toContain('confidential');

      const jar = await signIn(harness);
      const asAdmin = await harness.app.inject({
        method: 'GET',
        url: '/people/ion-antonescu',
        headers: { cookie: cookieHeader(jar) },
      });
      expect(asAdmin.body).toContain('Unpublished Chapter');
    });

    it('answers 404, never 403, for a private entity', async () => {
      await makeEntity(harness.pool, 'person', 'Private Person', 'private');

      const anonymous = await harness.app.inject({ method: 'GET', url: '/people/private-person' });
      expect(anonymous.statusCode).toBe(404);
      expect(anonymous.body).not.toContain('Private Person');

      // Identical to a slug that was never used, so the response cannot be
      // read as confirmation that something is there.
      const absent = await harness.app.inject({ method: 'GET', url: '/people/never-existed' });
      expect(absent.statusCode).toBe(404);
    });

    it('renders a mention of a private person as plain text, leaking nothing', async () => {
      await makeEntity(harness.pool, 'person', 'Hidden Informant', 'private');
      await makeEssay(
        harness.pool,
        'Public Essay',
        'public',
        'A source described as [[person:hidden-informant|an unnamed official]] spoke.',
      );

      const page = await harness.app.inject({ method: 'GET', url: '/essays/public-essay' });
      expect(page.statusCode).toBe(200);

      // The display text the author chose still reads.
      expect(page.body).toContain('an unnamed official');
      // But nothing identifying the target survives: no link, no title, no slug.
      expect(page.body).not.toContain('/people/hidden-informant');
      expect(page.body).not.toContain('hidden-informant');
      expect(page.body).not.toContain('Hidden Informant');
    });

    it('withholds a citation to a private source rather than printing its title', async () => {
      await makeSource(harness.pool, 'A Restricted File', 'private');
      await makeEssay(
        harness.pool,
        'Citing Essay',
        'public',
        'Argued.[[cite:a-restricted-file|3]]',
      );

      const page = await harness.app.inject({ method: 'GET', url: '/essays/citing-essay' });
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('Restricted File');
      expect(page.body).not.toContain('a-restricted-file');
    });
  });

  describe('graph traversal', () => {
    /**
     * public A -- private B -- public C, plus public A -- public D.
     *
     * B is the interesting one: an anonymous walk must not reach C through it,
     * because arriving at C would prove a connector exists.
     */
    async function chain(): Promise<{ a: number; b: number; c: number; d: number }> {
      const a = await makeEntity(harness.pool, 'person', 'Person A', 'public');
      const b = await makeEntity(harness.pool, 'organization', 'Org B', 'private');
      const c = await makeEntity(harness.pool, 'person', 'Person C', 'public');
      const d = await makeEntity(harness.pool, 'place', 'Place D', 'public');

      for (const [from, to] of [
        [a, b],
        [b, c],
        [a, d],
      ] as const) {
        const outcome = await createRelationship(harness.pool, {
          fromItemId: from,
          toItemId: to,
          predicateId: associatedWith,
          note: '',
          visibility: 'public',
        });
        expect(outcome.ok).toBe(true);
      }

      return { a, b, c, d };
    }

    it('never traverses through a private node', async () => {
      const { a, b, c, d } = await chain();
      const centre = (await findEntityById(harness.pool, 'person', a, admin))!;

      const anonymous = await buildGraph(harness.pool, centre, ANONYMOUS, 3);
      const reached = anonymous.nodes.map((node) => node.id);
      expect(reached).toContain(a);
      expect(reached).toContain(d);
      expect(reached).not.toContain(b);
      // C is only reachable through B, so it must not appear either.
      expect(reached).not.toContain(c);
      expect(JSON.stringify(anonymous)).not.toContain('Org B');

      const asAdmin = await buildGraph(harness.pool, centre, admin, 3);
      expect(asAdmin.nodes.map((node) => node.id).sort()).toEqual([a, b, c, d].sort());
    });

    it('hides an edge marked private even between two public nodes', async () => {
      const first = await makeEntity(harness.pool, 'person', 'Person One', 'public');
      const second = await makeEntity(harness.pool, 'person', 'Person Two', 'public');
      await createRelationship(harness.pool, {
        fromItemId: first,
        toItemId: second,
        predicateId: associatedWith,
        note: '',
        visibility: 'private',
      });

      const centre = (await findEntityById(harness.pool, 'person', first, admin))!;

      const anonymous = await buildGraph(harness.pool, centre, ANONYMOUS, 2);
      expect(anonymous.edges).toEqual([]);
      expect(anonymous.nodes.map((node) => node.id)).toEqual([first]);

      const asAdmin = await buildGraph(harness.pool, centre, admin, 2);
      expect(asAdmin.edges).toHaveLength(1);
    });

    it('draws a mention as its own kind of edge, filtered on the citing item', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      await makeEssay(harness.pool, 'Open Essay', 'public', 'On [[person:ion-antonescu]].');
      await makeEssay(harness.pool, 'Closed Essay', 'private', 'On [[person:ion-antonescu]].');

      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      const anonymous = await buildGraph(harness.pool, centre, ANONYMOUS, 2);
      expect(anonymous.edges.map((edge) => edge.relation)).toEqual(['mentioned']);
      expect(anonymous.nodes).toHaveLength(2);
      expect(JSON.stringify(anonymous)).not.toContain('Closed Essay');

      const asAdmin = await buildGraph(harness.pool, centre, admin, 2);
      expect(asAdmin.nodes).toHaveLength(3);
    });

    it('gives every node a usable href and reports the centre', async () => {
      const { a, d } = await chain();
      const centre = (await findEntityById(harness.pool, 'person', a, admin))!;
      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2);

      expect(graph.centre).toBe(a);
      for (const node of graph.nodes) expect(node.href).toMatch(/^\/[a-z]+\/[a-z0-9-]+$/);
      expect(graph.nodes.find((node) => node.id === d)?.href).toBe('/places/place-d');
      expect(graph.truncated).toBe(false);
    });
  });

  describe('offices and periods on the drawing', () => {
    /** One person, one organization, one dated office between them. */
    async function office(
      role: string,
      startDate: string | null,
      endDate: string | null,
    ): Promise<{ person: number; org: number }> {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      const org = await makeEntity(harness.pool, 'organization', 'Council of Ministers', 'public');
      const outcome = await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: role,
        startDate,
        endDate,
        datePrecision: 'year',
        note: '',
        visibility: 'public',
      });
      expect(outcome.ok).toBe(true);
      return { person, org };
    }

    it('carries the office and the period onto the edge', async () => {
      const { person } = await office('Prime Minister', '1941-01-01', '1944-01-01');
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]?.roleTitle).toBe('Prime Minister');
      expect(graph.edges[0]?.period).toBe('1941–1944');
      // What the drawing actually prints: the role leads, not the predicate.
      expect(graph.edges[0]?.display).toBe('Prime Minister, 1941–1944');
    });

    it('draws two posts at one organization as two edges', async () => {
      const { person, org } = await office('Minister of Defence', '1937-01-01', '1938-01-01');
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Prime Minister',
        startDate: '1941-01-01',
        endDate: '1944-01-01',
        datePrecision: 'year',
        note: '',
        visibility: 'public',
      });
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2);
      // Two claims about one pair, so two edges and still two nodes.
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges.map((edge) => edge.roleTitle).sort()).toEqual([
        'Minister of Defence',
        'Prime Minister',
      ]);
    });

    it('reads an edge forward even when the walk arrives from the far end', async () => {
      const { person, org } = await office('Prime Minister', '1941-01-01', '1944-01-01');

      // Centred on the organization, so the edge is discovered from its `to`
      // end rather than its `from` end.
      const centre = (await findEntityById(harness.pool, 'organization', org, admin))!;
      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2);

      expect(graph.edges).toHaveLength(1);
      // The drawing orients every edge from -> to and puts an arrowhead on it,
      // so the label has to read along that arrow. "Office held by" pointing
      // from the person to the institution says the opposite of the record.
      expect(graph.edges[0]?.source).toBe(person);
      expect(graph.edges[0]?.target).toBe(org);
      expect(graph.edges[0]?.label).toBe('Held office in');
      expect(graph.edges[0]?.display).toBe('Prime Minister, 1941–1944');
    });

    it('draws one edge when both of its ends are in the same layer', async () => {
      const centreId = await makeEntity(harness.pool, 'person', 'The Subject', 'public');
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      const org = await makeEntity(harness.pool, 'organization', 'Council of Ministers', 'public');

      // Deliberately unqualified. An edge carrying a role reads as that role
      // from either end, so it hid this: only a bare predicate, which reads
      // one way forward and another way back, shows the edge twice.
      const edges: [number, number, number][] = [
        [centreId, person, associatedWith],
        [centreId, org, associatedWith],
        [person, org, heldOffice],
      ];
      for (const [from, to, predicateId] of edges) {
        const created = await createRelationship(harness.pool, {
          fromItemId: from,
          toItemId: to,
          predicateId,
          note: '',
          visibility: 'public',
        });
        expect(created.ok).toBe(true);
      }

      const centre = (await findEntityById(harness.pool, 'person', centreId, admin))!;
      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2);

      // The centre reaches both ends of the third edge, so the next layer
      // holds them both and the walk finds that edge from either side at
      // once. Three claims, three edges -- not four, and not one of them
      // drawn twice with its wording reversed.
      expect(graph.edges).toHaveLength(3);
      const between = graph.edges.filter((edge) => edge.source === person && edge.target === org);
      expect(between).toHaveLength(1);
      expect(between[0]?.display).toBe('Held office in');
    });

    it('draws one mention edge when both of its ends are in the same layer', async () => {
      await makeEntity(harness.pool, 'person', 'Named Twice', 'public');
      await makeEntity(harness.pool, 'person', 'The Intermediary', 'public', {
        biography: 'Worked with [[person:named-twice]].',
      });
      const centreId = await makeEntity(harness.pool, 'person', 'The Subject', 'public', {
        biography: 'Knew [[person:the-intermediary]] and [[person:named-twice]].',
      });

      const centre = (await findEntityById(harness.pool, 'person', centreId, admin))!;
      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2);

      // The two people the centre names are one layer out, and one of them
      // names the other -- so that mention is reachable from both ends.
      const between = graph.edges.filter(
        (edge) => edge.relation === 'mentioned' && edge.source !== centre.id,
      );
      expect(between).toHaveLength(1);
      expect(between[0]?.display).toBe('mentions');
    });

    it('leaves an unqualified edge reading as its predicate', async () => {
      const one = await makeEntity(harness.pool, 'person', 'Person One', 'public');
      const two = await makeEntity(harness.pool, 'person', 'Person Two', 'public');
      await createRelationship(harness.pool, {
        fromItemId: one,
        toItemId: two,
        predicateId: associatedWith,
        note: '',
        visibility: 'public',
      });
      const centre = (await findEntityById(harness.pool, 'person', one, admin))!;

      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 1);
      expect(graph.edges[0]?.roleTitle).toBeNull();
      expect(graph.edges[0]?.period).toBeNull();
      expect(graph.edges[0]?.display).toBe('Associated with');
    });
  });

  /**
   * Two hops out, on the page rather than in the JSON.
   *
   * The reading itself is unit-tested over graph literals. What is asserted
   * here is the thing that would actually reach a reader: an item reachable
   * only through something private must be *absent*, not redacted -- and the
   * page must not name it, slug it, or hint that a route exists.
   */
  describe('two hops out', () => {
    /**
     * Just the "Connected through" section, or '' when the page has none.
     *
     * Scoping matters: a direct neighbour's name appears in the relationships
     * list above, so "not among the indirect ones" cannot be asserted over the
     * whole page without passing for the wrong reason.
     */
    function section(body: string): string {
      const start = body.indexOf('<section class="connected-through">');
      if (start === -1) return '';
      const end = body.indexOf('</section>', start);
      return body.slice(start, end === -1 ? undefined : end);
    }

    /** An asserted edge, defaulting to one anyone may see. */
    async function link(
      from: number,
      to: number,
      predicate: number,
      visibility: 'public' | 'private' = 'public',
    ): Promise<void> {
      const created = await createRelationship(harness.pool, {
        fromItemId: from,
        toItemId: to,
        predicateId: predicate,
        note: '',
        visibility,
      });
      expect(created.ok).toBe(true);
    }

    /**
     * Centre --[held office in]--> middle <--[held office in]-- far.
     *
     * Each argument says how visible that piece is, so one shape covers every
     * way the route can be cut.
     */
    async function chain(options: {
      middle?: 'public' | 'private';
      far?: 'public' | 'private';
      farEdge?: 'public' | 'private';
    }): Promise<{ centre: number; middle: number; far: number }> {
      const centre = await makeEntity(harness.pool, 'person', 'The Subject', 'public');
      const middle = await makeEntity(
        harness.pool,
        'organization',
        'Council of Ministers',
        options.middle ?? 'public',
      );
      const far = await makeEntity(
        harness.pool,
        'person',
        'Mihai Antonescu',
        options.far ?? 'public',
      );

      await link(centre, middle, heldOffice);
      await link(far, middle, heldOffice, options.farEdge ?? 'public');
      return { centre, middle, far };
    }

    it('names an item two hops out and what connects them', async () => {
      await chain({});

      const page = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Connected through');
      expect(page.body).toContain('Mihai Antonescu');
      expect(page.body).toContain('/people/mihai-antonescu');
      // The item in the middle, so the reader can see *why* they are connected
      // rather than being told that they are.
      expect(page.body).toContain('Council of Ministers');
      expect(page.body).toContain('Held office in');
    });

    it('omits the section entirely when there is no second hop', async () => {
      const centre = await makeEntity(harness.pool, 'person', 'The Subject', 'public');
      const middle = await makeEntity(harness.pool, 'organization', 'Council', 'public');
      await link(centre, middle, heldOffice);

      const page = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      expect(page.body).not.toContain('Connected through');
    });

    it('does not reach an item through a private intermediary', async () => {
      await chain({ middle: 'private' });

      // The institution is unpublished, so the route through it does not
      // exist for a reader -- and the person on the far side is absent, not
      // withheld. No title, no slug, no marker where a route was.
      const anonymous = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.body).not.toContain('Connected through');
      expect(anonymous.body).not.toContain('Mihai Antonescu');
      expect(anonymous.body).not.toContain('mihai-antonescu');
      expect(anonymous.body).not.toContain('Council of Ministers');

      const jar = await signIn(harness);
      const asAdmin = await harness.app.inject({
        method: 'GET',
        url: '/people/the-subject',
        headers: { cookie: cookieHeader(jar) },
      });
      expect(asAdmin.body).toContain('Connected through');
      expect(asAdmin.body).toContain('Mihai Antonescu');
    });

    it('does not list a private item on the far side', async () => {
      await chain({ far: 'private' });

      const anonymous = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      expect(anonymous.body).not.toContain('Connected through');
      expect(anonymous.body).not.toContain('Mihai Antonescu');
      expect(anonymous.body).not.toContain('mihai-antonescu');

      // The other half, so this is a test of the filter rather than of the
      // feature being absent.
      const jar = await signIn(harness);
      const asAdmin = await harness.app.inject({
        method: 'GET',
        url: '/people/the-subject',
        headers: { cookie: cookieHeader(jar) },
      });
      expect(section(asAdmin.body)).toContain('Mihai Antonescu');
    });

    it('does not reach an item through a private edge', async () => {
      await chain({ farEdge: 'private' });

      // Both people and the institution are published; the claim that the
      // second one held office there is not.
      const anonymous = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      expect(anonymous.body).not.toContain('Connected through');
      expect(anonymous.body).not.toContain('Mihai Antonescu');
      expect(anonymous.body).not.toContain('mihai-antonescu');

      const jar = await signIn(harness);
      const asAdmin = await harness.app.inject({
        method: 'GET',
        url: '/people/the-subject',
        headers: { cookie: cookieHeader(jar) },
      });
      expect(section(asAdmin.body)).toContain('Mihai Antonescu');
    });

    it('never lists a direct neighbour among the indirect ones', async () => {
      const { centre, middle, far } = await chain({});
      // Now connect them directly as well. The walk reaches them in one hop,
      // so they belong to the relationships list and not to this one.
      await link(centre, far, associatedWith);

      // Someone who really is two hops out, so the section exists and the
      // assertion below is about who is in it rather than about it being gone.
      const other = await makeEntity(harness.pool, 'person', 'Zoe Popescu', 'public');
      await link(other, middle, heldOffice);

      const page = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      const listed = section(page.body);
      expect(listed).toContain('Zoe Popescu');
      // Named in the relationships list above, and only there.
      expect(listed).not.toContain('Mihai Antonescu');
      expect(page.body).toContain('Mihai Antonescu');
    });

    it('connects two subjects named in the same piece of writing', async () => {
      await makeEntity(harness.pool, 'person', 'The Subject', 'public');
      await makeEntity(harness.pool, 'person', 'Mihai Antonescu', 'public');
      await makeEssay(
        harness.pool,
        'Report on the Commission',
        'public',
        'Both [[person:the-subject]] and [[person:mihai-antonescu]] attended.',
      );

      // Nobody asserted this connection; the prose did.
      const page = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      expect(page.body).toContain('Connected through');
      expect(page.body).toContain('Mihai Antonescu');
      expect(page.body).toContain('Report on the Commission');
    });

    it('does not connect two subjects through a private essay', async () => {
      await makeEntity(harness.pool, 'person', 'The Subject', 'public');
      await makeEntity(harness.pool, 'person', 'Mihai Antonescu', 'public');
      await makeEssay(
        harness.pool,
        'Unpublished Chapter',
        'private',
        'Both [[person:the-subject]] and [[person:mihai-antonescu]] attended.',
      );

      const anonymous = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      expect(anonymous.body).not.toContain('Connected through');
      expect(anonymous.body).not.toContain('Mihai Antonescu');
      expect(anonymous.body).not.toContain('Unpublished');
      expect(anonymous.body).not.toContain('unpublished-chapter');

      const jar = await signIn(harness);
      const asAdmin = await harness.app.inject({
        method: 'GET',
        url: '/people/the-subject',
        headers: { cookie: cookieHeader(jar) },
      });
      expect(section(asAdmin.body)).toContain('Mihai Antonescu');
    });

    /**
     * The editor shows the same section, read with the administrator's viewer.
     *
     * That difference is the point of having it here: the editor is where an
     * edge worth asserting becomes visible, and the connections the operator is
     * in the middle of recording are exactly the unpublished ones a reader
     * cannot reach.
     */
    it('shows the section on the editor, including a route a reader cannot take', async () => {
      const { centre } = await chain({ middle: 'private' });

      // The institution is unpublished, so no reader gets from one end to the
      // other...
      const anonymous = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      expect(anonymous.body).not.toContain('Connected through');

      // ...but the operator is the one recording it.
      const jar = await signIn(harness);
      const form = await harness.app.inject({
        method: 'GET',
        url: `/admin/people/${String(centre)}/edit`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(form.statusCode).toBe(200);
      expect(section(form.body)).toContain('Mihai Antonescu');
      expect(section(form.body)).toContain('Council of Ministers');
    });

    it('omits the section from the editor when there is no second hop', async () => {
      const centre = await makeEntity(harness.pool, 'person', 'The Subject', 'public');
      const jar = await signIn(harness);

      const form = await harness.app.inject({
        method: 'GET',
        url: `/admin/people/${String(centre)}/edit`,
        headers: { cookie: cookieHeader(jar) },
      });
      expect(form.body).not.toContain('Connected through');
    });

    it('keeps the section when a save is refused and the form comes back', async () => {
      // The re-render after a validation failure is its own code path, and the
      // one most likely to drift from the page it is supposed to reproduce.
      const { centre } = await chain({});
      const jar = await signIn(harness);
      const form = await harness.app.inject({
        method: 'GET',
        url: `/admin/people/${String(centre)}/edit`,
        headers: { cookie: cookieHeader(jar) },
      });

      const refused = await harness.app.inject({
        method: 'POST',
        url: `/admin/people/${String(centre)}`,
        headers: {
          cookie: cookieHeader(jar),
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({
          _csrf: csrfFrom(form.body),
          title: '',
          visibility: 'public',
        }).toString(),
      });

      expect(refused.statusCode).toBe(400);
      expect(section(refused.body)).toContain('Mihai Antonescu');
    });

    it('narrows to the year the page was asked for, as the drawing does', async () => {
      const centre = await makeEntity(harness.pool, 'person', 'The Subject', 'public');
      const middle = await makeEntity(harness.pool, 'organization', 'Council', 'public');
      const far = await makeEntity(harness.pool, 'person', 'Mihai Antonescu', 'public');

      for (const [from, start, end] of [
        [centre, '1940-01-01', '1944-01-01'],
        [far, '1950-01-01', '1955-01-01'],
      ] as const) {
        const created = await createRelationship(harness.pool, {
          fromItemId: from,
          toItemId: middle,
          predicateId: heldOffice,
          startDate: start,
          endDate: end,
          datePrecision: 'year',
          note: '',
          visibility: 'public',
        });
        expect(created.ok).toBe(true);
      }

      const unfiltered = await harness.app.inject({ method: 'GET', url: '/people/the-subject' });
      expect(unfiltered.body).toContain('Mihai Antonescu');

      // They were never there at the same time, so in 1941 there is no route
      // through the institution. The text and the drawing are one walk, so
      // they cannot disagree about which network is on screen.
      const inYear = await harness.app.inject({
        method: 'GET',
        url: '/people/the-subject?year=1941',
      });
      expect(inYear.body).not.toContain('Connected through');
      expect(inYear.body).not.toContain('Mihai Antonescu');
    });
  });

  describe('the network in one year', () => {
    /** A dated edge from a public person to a public organization. */
    async function dated(
      title: string,
      startDate: string | null,
      endDate: string | null,
    ): Promise<number> {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      const org = await makeEntity(harness.pool, 'organization', title, 'public');
      await createRelationship(harness.pool, {
        fromItemId: person,
        toItemId: org,
        predicateId: heldOffice,
        roleTitle: 'Member',
        startDate,
        endDate,
        datePrecision: 'year',
        note: '',
        visibility: 'public',
      });
      return person;
    }

    it('keeps an edge whose period covers the year', async () => {
      const person = await dated('Council of Ministers', '1940-09-06', '1944-08-23');
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2, { year: 1942 });
      expect(graph.year).toBe(1942);
      expect(graph.edges).toHaveLength(1);
      expect(graph.nodes).toHaveLength(2);
    });

    it('keeps an edge that starts or ends inside the year itself', async () => {
      // Overlap is tested against the whole calendar year, not against a day.
      const person = await dated('Council of Ministers', '1940-09-06', '1944-08-23');
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      for (const year of [1940, 1944]) {
        const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2, { year });
        expect(graph.edges).toHaveLength(1);
      }
    });

    it('drops an edge whose period ended before the year', async () => {
      const person = await dated('Council of Ministers', '1930-01-01', '1935-01-01');
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2, { year: 1942 });
      expect(graph.edges).toEqual([]);
      // With no edge there is no second node either.
      expect(graph.nodes.map((node) => node.id)).toEqual([person]);
    });

    it('drops an edge whose period had not started', async () => {
      const person = await dated('Council of Ministers', '1950-01-01', null);
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      expect((await buildGraph(harness.pool, centre, ANONYMOUS, 2, { year: 1942 })).edges).toEqual(
        [],
      );
    });

    it('keeps an open-ended edge that had already started', async () => {
      const person = await dated('Council of Ministers', '1930-01-01', null);
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      expect(
        (await buildGraph(harness.pool, centre, ANONYMOUS, 2, { year: 1942 })).edges,
      ).toHaveLength(1);
    });

    it('always keeps an edge with no dates recorded', async () => {
      // An unknown period is not an absent one. Hiding undated edges would
      // make the filter quietly lose most of a half-recorded corpus.
      const person = await dated('Council of Ministers', null, null);
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      expect(
        (await buildGraph(harness.pool, centre, ANONYMOUS, 2, { year: 1942 })).edges,
      ).toHaveLength(1);
    });

    it('never narrows a mention, which carries no period at all', async () => {
      const person = await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      await makeEssay(harness.pool, 'Open Essay', 'public', 'On [[person:ion-antonescu]].');
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 2, { year: 1600 });
      expect(graph.edges.map((edge) => edge.relation)).toEqual(['mentioned']);
    });

    it('reports no year when the walk was not filtered', async () => {
      const person = await dated('Council of Ministers', '1940-01-01', '1944-01-01');
      const centre = (await findEntityById(harness.pool, 'person', person, admin))!;

      expect((await buildGraph(harness.pool, centre, ANONYMOUS, 2)).year).toBeNull();
      expect(
        (await buildGraph(harness.pool, centre, ANONYMOUS, 2, { year: null })).year,
      ).toBeNull();
    });

    it('cannot reach a private node at any year', async () => {
      // The year narrows on top of the visibility filter, never instead of it.
      // public A -- private B -- public C, every edge dated and public.
      const a = await makeEntity(harness.pool, 'person', 'Person A', 'public');
      const b = await makeEntity(harness.pool, 'organization', 'Org B', 'private');
      const c = await makeEntity(harness.pool, 'person', 'Person C', 'public');
      for (const [from, to] of [
        [a, b],
        [b, c],
      ] as const) {
        await createRelationship(harness.pool, {
          fromItemId: from,
          toItemId: to,
          predicateId: heldOffice,
          roleTitle: 'Member',
          startDate: '1930-01-01',
          endDate: '1950-01-01',
          datePrecision: 'year',
          note: '',
          visibility: 'public',
        });
      }
      const centre = (await findEntityById(harness.pool, 'person', a, admin))!;

      for (const year of [1900, 1942, 2000]) {
        const graph = await buildGraph(harness.pool, centre, ANONYMOUS, 3, { year });
        const reached = graph.nodes.map((node) => node.id);
        expect(reached).not.toContain(b);
        expect(reached).not.toContain(c);
        expect(JSON.stringify(graph)).not.toContain('Org B');
      }
    });

    it('carries the year into the page without reflecting the query string', async () => {
      await dated('Council of Ministers', '1940-01-01', '1944-01-01');

      const page = await harness.app.inject({
        method: 'GET',
        url: '/people/ion-antonescu?year=1942',
      });
      expect(page.statusCode).toBe(200);
      // The year survives a reload, so the control works without JavaScript.
      expect(page.body).toContain('/graph/people/ion-antonescu.json?year=1942');

      // A hostile year is re-parsed, not echoed: it reaches neither the data
      // URL nor the input's value.
      const hostile = await harness.app.inject({
        method: 'GET',
        url: `/people/ion-antonescu?year=${encodeURIComponent('"><script>alert(1)</script>')}`,
      });
      expect(hostile.statusCode).toBe(200);
      expect(hostile.body).not.toContain('<script>alert(1)</script>');
      expect(hostile.body).not.toContain('.json?year=');
      expect(hostile.body).toContain('/graph/people/ion-antonescu.json"');
    });

    it('honours ?year= on the endpoint and ignores a nonsense value', async () => {
      const person = await dated('Council of Ministers', '1930-01-01', '1935-01-01');
      expect(person).toBeGreaterThan(0);

      const filtered = await harness.app.inject({
        method: 'GET',
        url: '/graph/people/ion-antonescu.json?year=1942',
      });
      expect(filtered.statusCode).toBe(200);
      const body = filtered.json<Graph>();
      expect(body.year).toBe(1942);
      expect(body.edges).toEqual([]);

      // Anything that is not a plain year is read as "no filter", so a
      // hand-edited query string cannot empty the drawing.
      for (const value of ['banana', '-5', '99999', '19.5', '']) {
        const response = await harness.app.inject({
          method: 'GET',
          url: `/graph/people/ion-antonescu.json?year=${encodeURIComponent(value)}`,
        });
        expect(response.statusCode).toBe(200);
        const unfiltered = response.json<Graph>();
        expect(unfiltered.year).toBeNull();
        expect(unfiltered.edges).toHaveLength(1);
      }
    });
  });

  describe('the graph endpoint', () => {
    it('serves JSON for a public entity and 404s a private one', async () => {
      await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');
      await makeEntity(harness.pool, 'person', 'Hidden Person', 'private');
      await makeEssay(harness.pool, 'An Essay', 'public', 'On [[person:ion-antonescu]].');

      const served = await harness.app.inject({
        method: 'GET',
        url: '/graph/people/ion-antonescu.json',
      });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toContain('application/json');

      const graph = served.json<{ nodes: { title: string }[]; edges: unknown[] }>();
      expect(graph.nodes.map((node) => node.title).sort()).toEqual(['An Essay', 'Ion Antonescu']);
      expect(graph.edges).toHaveLength(1);

      const refused = await harness.app.inject({
        method: 'GET',
        url: '/graph/people/hidden-person.json',
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.body).not.toContain('Hidden Person');
    });

    it('404s an unknown kind or a malformed slug rather than erroring', async () => {
      for (const url of [
        '/graph/essays/anything.json',
        '/graph/nonsense/anything.json',
        '/graph/people/Not A Slug.json',
      ]) {
        const response = await harness.app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(404);
      }
    });

    it('clamps the requested depth instead of trusting the query string', async () => {
      await makeEntity(harness.pool, 'person', 'Ion Antonescu', 'public');

      for (const depth of ['99', '-1', 'abc', '']) {
        const response = await harness.app.inject({
          method: 'GET',
          url: `/graph/people/ion-antonescu.json?depth=${encodeURIComponent(depth)}`,
        });
        expect(response.statusCode, depth).toBe(200);
      }
    });
  });
});
