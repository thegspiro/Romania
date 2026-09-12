/**
 * The relationship network, as nodes and edges.
 *
 * Two kinds of edge feed it:
 *
 *   - **asserted** — a typed `relationship` the operator created deliberately.
 *   - **mentioned** — derived from prose: this essay names that person.
 *
 * They are drawn differently because they mean different things. An asserted
 * edge is a claim; a mention is a trace of where the writing goes.
 *
 * Traversal is breadth-first with a hard hop limit and a hard node budget. A
 * research corpus is densely connected, and an unbounded walk from a
 * well-connected person would try to return the whole database to a browser.
 *
 * Every step re-applies the visibility filter, so a private node is not merely
 * hidden from the drawing -- it is never traversed *through*. Otherwise the
 * shape of the graph would betray a private node sitting between two public
 * ones.
 *
 * An asserted edge may carry an office and a period, which is what lets the
 * walk be asked for the network as it stood in one year. That filter narrows
 * the drawing and is applied on top of the visibility test, never instead of
 * it: no year makes a private node reachable.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { queryRows, type Pool, type PoolConnection } from '../db/pool.js';
import { visibilityFilter, type Viewer } from './visibility.js';
import { referenceHref } from './references.js';
import { columnToIsoDate, edgeLabel, formatPeriod, isPeriodPrecision } from './relationships.js';

export interface GraphNode {
  id: number;
  kind: string;
  title: string;
  href: string;
  /** Hops from the node the graph was centred on. */
  distance: number;
}

export interface GraphEdge {
  source: number;
  target: number;
  /** The predicate, read in the direction the edge is drawn. */
  label: string;
  /** The office the edge was held in, when one was recorded. */
  roleTitle: string | null;
  /** The period as prose, or null when neither end is known. */
  period: string | null;
  /** What to draw on the edge: the role leads when there is one. */
  display: string;
  relation: 'asserted' | 'mentioned';
}

export interface Graph {
  centre: number;
  /** The year the walk was filtered to, or null when it was not filtered. */
  year: number | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the budget stopped the walk before it ran out of neighbours. */
  truncated: boolean;
}

const MAX_NODES = 150;
const MAX_DEPTH = 3;

interface NeighbourRow extends RowDataPacket {
  other_id: number;
  other_kind: string;
  other_title: string;
  label: string;
  role_title: string | null;
  start_date: unknown;
  end_date: unknown;
  date_precision: string | null;
  relation: 'asserted' | 'mentioned';
  from_id: number;
  to_id: number;
  /** The `relationship` row this came from; null for a mention. */
  edge_id: number | null;
}

/**
 * Fetches every visible neighbour of a set of nodes in one query per layer.
 *
 * Each relation is asked twice, once from either end, because a neighbour may
 * lie on either side of the edge. Both branches label the edge with the
 * *forward* reading: the drawing orients every edge from `from_item_id` to
 * `to_item_id` and puts an arrowhead on it, so the label that reads correctly
 * along that arrow is the predicate's own -- never its inverse, which would
 * print "Has member" on an arrow pointing from the person to the institution.
 * The inverse belongs to `listRelationshipsFor`, which reads an edge from one
 * item's point of view rather than drawing it.
 *
 * That also makes the two branches agree, so an edge whose *both* endpoints
 * are in the same layer is one row twice over rather than two contradictory
 * edges. `buildGraph` then collapses it on the edge's own identity.
 *
 * Placeholders are generated from the batch size; every id is bound.
 */
async function neighboursOf(
  db: Pool | PoolConnection,
  ids: readonly number[],
  viewer: Viewer,
  year: number | null,
): Promise<NeighbourRow[]> {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const edge = visibilityFilter(viewer, 'r');
  const near = visibilityFilter(viewer, 'ci');
  const far = visibilityFilter(viewer, 'other');

  // Interval overlap against the whole calendar year, compared as dates so
  // ix_relationship_period stays usable. An edge with no dates always shows:
  // "no period recorded" is not "did not exist then". A mention carries no
  // dates at all, so the two mention branches are never narrowed.
  const period =
    year === null
      ? ''
      : ' AND (r.start_date IS NULL OR r.start_date <= ?)' +
        ' AND (r.end_date IS NULL OR r.end_date >= ?)';
  const periodParams: string[] =
    year === null
      ? []
      : [`${String(year).padStart(4, '0')}-12-31`, `${String(year).padStart(4, '0')}-01-01`];

  return queryRows<NeighbourRow>(
    db,
    `SELECT other.id AS other_id, other.kind AS other_kind, other.title AS other_title,
            p.label AS label, r.role_title AS role_title,
            r.start_date AS start_date, r.end_date AS end_date,
            r.date_precision AS date_precision, 'asserted' AS relation,
            r.from_item_id AS from_id, r.to_item_id AS to_id, r.id AS edge_id
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.from_item_id
       JOIN content_item other ON other.id = r.to_item_id
      WHERE r.from_item_id IN (${placeholders})
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}${period}

      UNION ALL

     SELECT other.id, other.kind, other.title,
            p.label, r.role_title, r.start_date, r.end_date,
            r.date_precision, 'asserted',
            r.from_item_id, r.to_item_id, r.id
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.to_item_id
       JOIN content_item other ON other.id = r.from_item_id
      WHERE r.to_item_id IN (${placeholders})
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}${period}

      UNION ALL

     SELECT other.id, other.kind, other.title,
            'mentions', NULL, NULL, NULL, 'unknown', 'mentioned',
            m.from_item_id, m.to_item_id, NULL
       FROM mention m
       JOIN content_item ci ON ci.id = m.from_item_id
       JOIN content_item other ON other.id = m.to_item_id
      WHERE m.from_item_id IN (${placeholders})
        AND ${near.sql} AND ${far.sql}

      UNION ALL

     SELECT other.id, other.kind, other.title,
            'mentions', NULL, NULL, NULL, 'unknown', 'mentioned',
            m.from_item_id, m.to_item_id, NULL
       FROM mention m
       JOIN content_item ci ON ci.id = m.to_item_id
       JOIN content_item other ON other.id = m.from_item_id
      WHERE m.to_item_id IN (${placeholders})
        AND ${near.sql} AND ${far.sql}`,
    [
      ...ids,
      ...edge.params,
      ...near.params,
      ...far.params,
      ...periodParams,
      ...ids,
      ...edge.params,
      ...near.params,
      ...far.params,
      ...periodParams,
      ...ids,
      ...near.params,
      ...far.params,
      ...ids,
      ...near.params,
      ...far.params,
    ],
  );
}

/** The year an edge is tested against, or null for "every year at once". */
export interface GraphOptions {
  /**
   * Restricts asserted edges to those whose period covers this calendar year.
   * Out-of-range values are ignored rather than refused, so a hand-edited
   * query string cannot empty the drawing in a way that looks like a leak.
   */
  year?: number | null;
}

/** Normalises a year from a query string. */
export function parseGraphYear(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value.trim())) return null;
  const year = Number(value.trim());
  return year >= 1 && year <= 9999 ? year : null;
}

/** Builds the neighbourhood around one item. */
export async function buildGraph(
  db: Pool | PoolConnection,
  centre: { id: number; kind: string; slug: string; title: string },
  viewer: Viewer,
  depth = 2,
  options: GraphOptions = {},
): Promise<Graph> {
  const maxDepth = Math.min(Math.max(Math.trunc(depth), 1), MAX_DEPTH);
  const year =
    typeof options.year === 'number' && Number.isSafeInteger(options.year) ? options.year : null;

  const nodes = new Map<number, GraphNode>([
    [
      centre.id,
      {
        id: centre.id,
        kind: centre.kind,
        title: centre.title,
        href: referenceHref(centre.kind, centre.slug),
        distance: 0,
      },
    ],
  ]);
  const edges = new Map<string, GraphEdge>();

  let frontier: number[] = [centre.id];
  let truncated = false;

  for (let distance = 1; distance <= maxDepth && frontier.length > 0; distance += 1) {
    const rows = await neighboursOf(db, frontier, viewer, year);
    const next: number[] = [];

    for (const row of rows) {
      const otherId = Number(row.other_id);
      if (otherId === centre.id && distance > 1) continue;

      if (!nodes.has(otherId)) {
        if (nodes.size >= MAX_NODES) {
          truncated = true;
          continue;
        }
        // The slug is not selected: the href is rebuilt from kind and id-free
        // data on the client via the node's own page link, so fetch it here.
        nodes.set(otherId, {
          id: otherId,
          kind: row.other_kind,
          title: row.other_title,
          href: '',
          distance,
        });
        next.push(otherId);
      }

      const source = Number(row.from_id);
      const target = Number(row.to_id);
      const period = formatPeriod({
        startDate: columnToIsoDate(row.start_date),
        endDate: columnToIsoDate(row.end_date),
        precision: isPeriodPrecision(row.date_precision) ? row.date_precision : 'unknown',
      });
      const display = edgeLabel(row.label, row.role_title, period);

      // One row, however many ways the walk arrived at it. Keyed on the
      // edge's own id rather than on what it renders as, so two posts held at
      // the same organization stay two edges -- and so would two predicates
      // that happened to share a label.
      //
      // A mention has no single row to key on: several occurrences in one
      // piece of prose are several `mention` rows but one statement that this
      // text names that subject, which is what the drawing shows.
      const key =
        row.relation === 'asserted'
          ? `asserted:${String(row.edge_id)}`
          : `mentioned:${source}:${target}`;
      if (!edges.has(key)) {
        edges.set(key, {
          source,
          target,
          label: row.label,
          roleTitle: row.role_title,
          period,
          display,
          relation: row.relation,
        });
      }
    }

    frontier = next;
  }

  // Fill in hrefs in one query rather than selecting slugs through four
  // UNION branches.
  const discovered = [...nodes.keys()].filter((id) => nodes.get(id)?.href === '');
  if (discovered.length > 0) {
    const placeholders = discovered.map(() => '?').join(', ');
    const rows = await queryRows<RowDataPacket & { id: number; kind: string; slug: string }>(
      db,
      `SELECT id, kind, slug FROM content_item WHERE id IN (${placeholders})`,
      discovered,
    );
    for (const row of rows) {
      const node = nodes.get(Number(row.id));
      if (node !== undefined) node.href = referenceHref(row.kind, row.slug);
    }
  }

  // Drop any edge whose endpoints did not both survive the node budget, so
  // the drawing never references a node it does not contain.
  const kept = [...edges.values()].filter(
    (item) => nodes.has(item.source) && nodes.has(item.target),
  );

  return { centre: centre.id, year, nodes: [...nodes.values()], edges: kept, truncated };
}

// --- Two hops out ----------------------------------------------------------

/**
 * How many indirect connections a page lists, and how many routes it shows for
 * each. Both are presentation limits, not visibility ones -- what is omitted
 * here was already visible, and the page says it is showing part.
 */
const MAX_CONNECTIONS = 25;
const MAX_ROUTES = 4;

/**
 * One side of a two-hop route, stated in the direction it was asserted.
 *
 * Both ends are named rather than one, so a hop reads correctly whichever way
 * its edge points and no inverse wording is needed. That keeps this text a
 * transcription of the drawing rather than a second phrasing of it -- the
 * inverse belongs to `listRelationshipsFor`, which reads an edge from one
 * item's point of view instead of drawing it.
 */
export interface ConnectionHop {
  from: { title: string; href: string };
  to: { title: string; href: string };
  /** The edge's own reading, role and period folded in, as the drawing shows. */
  label: string;
  relation: 'asserted' | 'mentioned';
}

/** One way through: the item in the middle, and the hop on either side of it. */
export interface ConnectionRoute {
  through: GraphNode;
  /** Centre to intermediary, then intermediary to the far item. */
  hops: ConnectionHop[];
}

export interface IndirectConnection {
  node: GraphNode;
  routes: ConnectionRoute[];
  /** Routes past the per-connection cap, so the page can say there are more. */
  moreRoutes: number;
}

export interface IndirectConnections {
  items: IndirectConnection[];
  /** How many there were before the cap. */
  total: number;
}

/** Enough to tell two edges of one graph apart; the pair and period are unique. */
function edgeKey(edge: GraphEdge): string {
  return `${edge.relation}:${String(edge.source)}:${String(edge.target)}:${edge.display}`;
}

/** Deterministic across platforms, where `localeCompare` is not. */
function byText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** A route of two asserted edges is a stronger claim than one built on prose. */
function routeWeight(route: ConnectionRoute): number {
  return route.hops.filter((hop) => hop.relation === 'asserted').length;
}

/**
 * Items two hops from the centre, and what connects them.
 *
 * This is the reading the network view has always had and the page never did:
 * "these two were both in that ministry" is the sort of thing a corpus knows
 * and nobody typed. Until now it existed only as JSON handed to Cytoscape, so
 * it could not be read without JavaScript, searched in the page, or printed.
 *
 * **Nothing here decides visibility, and nothing here queries.** It is a pure
 * derivation from a `Graph` that `buildGraph` already filtered at every hop:
 * a private node is never traversed *through*, so an item reachable only via
 * one is simply not in the graph, and is therefore not in this list -- with no
 * gap where it was. Adding a query here would put a second copy of the rule
 * outside the chokepoint; do not.
 *
 * A node at distance 2 is by construction not also a direct neighbour -- the
 * walk would have given it distance 1 -- so "indirect" needs no separate test.
 */
export function indirectConnections(
  graph: Graph,
  options: { limit?: number; routes?: number } = {},
): IndirectConnections {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? MAX_CONNECTIONS), 1), 200);
  const routeLimit = Math.min(Math.max(Math.trunc(options.routes ?? MAX_ROUTES), 1), 20);

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));

  // Edges indexed by both endpoints, so stepping from one node to the next is
  // a lookup rather than a scan of every edge for every node.
  const incident = new Map<number, GraphEdge[]>();
  for (const edge of graph.edges) {
    for (const id of [edge.source, edge.target]) {
      const found = incident.get(id);
      if (found === undefined) incident.set(id, [edge]);
      else found.push(edge);
    }
  }

  function otherEnd(edge: GraphEdge, id: number): number {
    return edge.source === id ? edge.target : edge.source;
  }

  function hopOf(edge: GraphEdge): ConnectionHop | null {
    const from = nodes.get(edge.source);
    const to = nodes.get(edge.target);
    if (from === undefined || to === undefined) return null;
    return {
      from: { title: from.title, href: from.href },
      to: { title: to.title, href: to.href },
      label: edge.display,
      relation: edge.relation,
    };
  }

  const found: { node: GraphNode; routes: ConnectionRoute[] }[] = [];

  for (const far of graph.nodes) {
    if (far.distance !== 2) continue;

    const routes: ConnectionRoute[] = [];
    const seen = new Set<string>();

    for (const second of incident.get(far.id) ?? []) {
      const middle = nodes.get(otherEnd(second, far.id));
      // Only a direct neighbour can be the item in the middle. At depth 3 the
      // far node also has edges to its own peers, which are not routes home.
      if (middle === undefined || middle.distance !== 1) continue;

      for (const first of incident.get(middle.id) ?? []) {
        if (otherEnd(first, middle.id) !== graph.centre) continue;

        const key = `${edgeKey(first)}|${edgeKey(second)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const firstHop = hopOf(first);
        const secondHop = hopOf(second);
        if (firstHop === null || secondHop === null) continue;
        routes.push({ through: middle, hops: [firstHop, secondHop] });
      }
    }

    if (routes.length === 0) continue;
    routes.sort(
      (left, right) =>
        routeWeight(right) - routeWeight(left) || byText(left.through.title, right.through.title),
    );
    found.push({ node: far, routes });
  }

  // Most-connected first: several ways through is the finding, and burying it
  // alphabetically is what made this material invisible in the first place.
  found.sort(
    (left, right) =>
      right.routes.length - left.routes.length ||
      right.routes.filter((route) => routeWeight(route) === 2).length -
        left.routes.filter((route) => routeWeight(route) === 2).length ||
      byText(left.node.title, right.node.title),
  );

  return {
    items: found.slice(0, limit).map((entry) => ({
      node: entry.node,
      routes: entry.routes.slice(0, routeLimit),
      moreRoutes: Math.max(entry.routes.length - routeLimit, 0),
    })),
    total: found.length,
  };
}
