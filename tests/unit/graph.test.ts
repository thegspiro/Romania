/**
 * Two hops out, as a pure function.
 *
 * `indirectConnections` is the one part of the relational view that makes no
 * query and no visibility decision: it derives a reading from a `Graph` that
 * `buildGraph` has already filtered at every hop. That is exactly why it can
 * be tested here over graph literals -- and why the tests that matter for
 * *disclosure* live in tests/integration/graph.test.ts instead, against a real
 * database and over rendered pages.
 *
 * What is asserted here is the reading: which items count as indirect, what
 * connects them, which way each hop points, and the order the findings arrive
 * in.
 */
import { describe, expect, it } from 'vitest';
import {
  indirectConnections,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from '../../src/content/graph.js';

function node(id: number, title: string, distance: number, kind = 'person'): GraphNode {
  return { id, kind, title, href: `/people/${title.toLowerCase().replace(/ /g, '-')}`, distance };
}

function edge(
  source: number,
  target: number,
  display: string,
  relation: 'asserted' | 'mentioned' = 'asserted',
): GraphEdge {
  return { source, target, label: display, roleTitle: null, period: null, display, relation };
}

/** Centre 1, intermediary 2, far 3 -- the shape every case here varies. */
function graph(nodes: GraphNode[], edges: GraphEdge[], centre = 1): Graph {
  return { centre, year: null, nodes, edges, truncated: false };
}

const CENTRE = node(1, 'The Subject', 0);

describe('indirectConnections', () => {
  it('finds an item two hops out and names what connects them', () => {
    const result = indirectConnections(
      graph(
        [CENTRE, node(2, 'Council of Ministers', 1, 'organization'), node(3, 'Mihai', 2)],
        [edge(1, 2, 'Held office in'), edge(3, 2, 'Held office in')],
      ),
    );

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);

    const [connection] = result.items;
    expect(connection?.node.title).toBe('Mihai');
    expect(connection?.routes).toHaveLength(1);
    expect(connection?.routes[0]?.through.title).toBe('Council of Ministers');
  });

  it('prints each hop in the direction it was asserted, both ends named', () => {
    const result = indirectConnections(
      graph(
        [CENTRE, node(2, 'Council of Ministers', 1, 'organization'), node(3, 'Mihai', 2)],
        // The second edge points *into* the intermediary, the first out of it.
        [edge(1, 2, 'Held office in'), edge(3, 2, 'Held office in')],
      ),
    );

    const hops = result.items[0]?.routes[0]?.hops ?? [];
    expect(hops).toHaveLength(2);
    // Read as stored, so neither hop needs an inverse wording to be correct.
    expect(hops[0]).toMatchObject({
      from: { title: 'The Subject' },
      label: 'Held office in',
      to: { title: 'Council of Ministers' },
    });
    expect(hops[1]).toMatchObject({
      from: { title: 'Mihai' },
      label: 'Held office in',
      to: { title: 'Council of Ministers' },
    });
  });

  it('never lists a direct neighbour', () => {
    // A node the walk reached in one hop has distance 1, whichever other
    // routes also exist to it, so "indirect" needs no separate test.
    const result = indirectConnections(
      graph(
        [CENTRE, node(2, 'Council of Ministers', 1, 'organization'), node(3, 'Mihai', 1)],
        [edge(1, 2, 'Held office in'), edge(1, 3, 'Associated with'), edge(3, 2, 'Held office in')],
      ),
    );

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('never lists the centre itself', () => {
    const result = indirectConnections(
      graph([CENTRE, node(2, 'Council', 1, 'organization')], [edge(1, 2, 'Held office in')]),
    );
    expect(result.items).toEqual([]);
  });

  it('gathers several ways through onto one connection', () => {
    const result = indirectConnections(
      graph(
        [
          CENTRE,
          node(2, 'Council of Ministers', 1, 'organization'),
          node(4, 'The Legion', 1, 'organization'),
          node(3, 'Mihai', 2),
        ],
        [
          edge(1, 2, 'Held office in'),
          edge(3, 2, 'Held office in'),
          edge(1, 4, 'Member of'),
          edge(3, 4, 'Member of'),
        ],
      ),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.routes.map((route) => route.through.title)).toEqual([
      'Council of Ministers',
      'The Legion',
    ]);
  });

  it('puts the most connected first, not the alphabetically first', () => {
    const result = indirectConnections(
      graph(
        [
          CENTRE,
          node(2, 'Council of Ministers', 1, 'organization'),
          node(4, 'The Legion', 1, 'organization'),
          node(3, 'Zoe', 2),
          node(5, 'Alexandru', 2),
        ],
        [
          edge(1, 2, 'Held office in'),
          edge(1, 4, 'Member of'),
          // Zoe is reachable two ways, Alexandru one.
          edge(3, 2, 'Held office in'),
          edge(3, 4, 'Member of'),
          edge(5, 2, 'Held office in'),
        ],
      ),
    );

    // Several ways through is the finding; burying it alphabetically is what
    // kept this material invisible.
    expect(result.items.map((item) => item.node.title)).toEqual(['Zoe', 'Alexandru']);
  });

  it('ranks a route of asserted edges above one built on prose', () => {
    const result = indirectConnections(
      graph(
        [
          CENTRE,
          node(2, 'An Essay', 1, 'essay'),
          node(4, 'Council of Ministers', 1, 'organization'),
          node(3, 'Mihai', 2),
        ],
        [
          edge(2, 1, 'mentions', 'mentioned'),
          edge(2, 3, 'mentions', 'mentioned'),
          edge(1, 4, 'Held office in'),
          edge(3, 4, 'Held office in'),
        ],
      ),
    );

    const routes = result.items[0]?.routes ?? [];
    expect(routes[0]?.through.title).toBe('Council of Ministers');
    expect(routes[0]?.hops.every((hop) => hop.relation === 'asserted')).toBe(true);
    expect(routes[1]?.through.title).toBe('An Essay');
  });

  it('connects two subjects named in the same piece of writing', () => {
    // Nobody asserted this edge; the prose did. It is still a connection, and
    // it is the kind nothing on the page surfaced before.
    const result = indirectConnections(
      graph(
        [CENTRE, node(2, 'An Essay', 1, 'essay'), node(3, 'Mihai', 2)],
        [edge(2, 1, 'mentions', 'mentioned'), edge(2, 3, 'mentions', 'mentioned')],
      ),
    );

    expect(result.items[0]?.node.title).toBe('Mihai');
    expect(result.items[0]?.routes[0]?.through.title).toBe('An Essay');
    expect(result.items[0]?.routes[0]?.hops.every((hop) => hop.relation === 'mentioned')).toBe(
      true,
    );
  });

  it('caps the list and says how many there were', () => {
    const nodes: GraphNode[] = [CENTRE, node(2, 'Council', 1, 'organization')];
    const edges: GraphEdge[] = [edge(1, 2, 'Held office in')];
    for (let index = 0; index < 30; index += 1) {
      nodes.push(node(100 + index, `Person ${String(index).padStart(2, '0')}`, 2));
      edges.push(edge(100 + index, 2, 'Held office in'));
    }

    const result = indirectConnections(graph(nodes, edges), { limit: 10 });
    expect(result.items).toHaveLength(10);
    // What was dropped was already visible, so the count discloses nothing --
    // it is a truncation notice, not a marker where something was withheld.
    expect(result.total).toBe(30);
  });

  it('caps the ways through and counts the rest', () => {
    const nodes: GraphNode[] = [CENTRE, node(3, 'Mihai', 2)];
    const edges: GraphEdge[] = [];
    for (let index = 0; index < 6; index += 1) {
      const middle = 200 + index;
      nodes.push(node(middle, `Body ${String(index)}`, 1, 'organization'));
      edges.push(edge(1, middle, 'Member of'), edge(3, middle, 'Member of'));
    }

    const result = indirectConnections(graph(nodes, edges), { routes: 2 });
    expect(result.items[0]?.routes).toHaveLength(2);
    expect(result.items[0]?.moreRoutes).toBe(4);
  });

  it('ignores an edge between two items that are both two hops out', () => {
    // At depth 3 the far nodes have edges to each other. Those are not ways
    // home, and counting one would invent a route through a peer.
    const result = indirectConnections(
      graph(
        [CENTRE, node(2, 'Council', 1, 'organization'), node(3, 'Mihai', 2), node(4, 'Zoe', 2)],
        [edge(1, 2, 'Held office in'), edge(3, 2, 'Held office in'), edge(3, 4, 'Family of')],
      ),
    );

    expect(result.items.map((item) => item.node.title)).toEqual(['Mihai']);
    expect(result.items[0]?.routes).toHaveLength(1);
  });

  it('returns nothing for a graph with no second hop', () => {
    expect(indirectConnections(graph([CENTRE], []))).toEqual({ items: [], total: 0 });
  });
});
