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
import { columnToIsoDate, edgeLabel, formatPeriod, isDatePrecision } from './relationships.js';

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
}

/**
 * Fetches every visible neighbour of a set of nodes in one query per layer.
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
            r.from_item_id AS from_id, r.to_item_id AS to_id
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.from_item_id
       JOIN content_item other ON other.id = r.to_item_id
      WHERE r.from_item_id IN (${placeholders})
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}${period}

      UNION ALL

     SELECT other.id, other.kind, other.title,
            p.inverse_label, r.role_title, r.start_date, r.end_date,
            r.date_precision, 'asserted',
            r.from_item_id, r.to_item_id
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.to_item_id
       JOIN content_item other ON other.id = r.from_item_id
      WHERE r.to_item_id IN (${placeholders})
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}${period}

      UNION ALL

     SELECT other.id, other.kind, other.title,
            'mentions', NULL, NULL, NULL, 'unknown', 'mentioned',
            m.from_item_id, m.to_item_id
       FROM mention m
       JOIN content_item ci ON ci.id = m.from_item_id
       JOIN content_item other ON other.id = m.to_item_id
      WHERE m.from_item_id IN (${placeholders})
        AND ${near.sql} AND ${far.sql}

      UNION ALL

     SELECT other.id, other.kind, other.title,
            'mentioned in', NULL, NULL, NULL, 'unknown', 'mentioned',
            m.from_item_id, m.to_item_id
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
        precision: isDatePrecision(row.date_precision) ? row.date_precision : 'unknown',
      });
      const display = edgeLabel(row.label, row.role_title, period);

      // The office and the period are part of the identity of an edge: two
      // posts held at the same organization are two edges, not one drawn
      // twice.
      const key = `${source}-${target}-${row.relation}-${display}`;
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
