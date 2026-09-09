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
  databaseAvailable,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { makeEntity, makeEssay, makeSource } from './fixtures.js';
import { buildGraph } from '../../src/content/graph.js';
import { createRelationship, listPredicates } from '../../src/content/relationships.js';
import { findEntityById } from '../../src/content/entities.js';
import { ANONYMOUS, adminViewer } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('relational browsing', () => {
  let harness: Harness;
  let admin: ReturnType<typeof adminViewer>;
  let associatedWith: number;

  beforeAll(async () => {
    harness = await createHarness();
    admin = adminViewer(harness.userId);
    const predicates = await listPredicates(harness.pool);
    associatedWith = predicates.find((predicate) => predicate.code === 'associated_with')!.id;
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
