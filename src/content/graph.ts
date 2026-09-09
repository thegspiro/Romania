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
 */
import type { RowDataPacket } from 'mysql2/promise';
import { queryRows, type Pool, type PoolConnection } from '../db/pool.js';
import { visibilityFilter, type Viewer } from './visibility.js';
import { referenceHref } from './references.js';

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
  label: string;
  relation: 'asserted' | 'mentioned';
}

export interface Graph {
  centre: number;
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
): Promise<NeighbourRow[]> {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const edge = visibilityFilter(viewer, 'r');
  const near = visibilityFilter(viewer, 'ci');
  const far = visibilityFilter(viewer, 'other');

  return queryRows<NeighbourRow>(
    db,
    `SELECT other.id AS other_id, other.kind AS other_kind, other.title AS other_title,
            p.label AS label, 'asserted' AS relation,
            r.from_item_id AS from_id, r.to_item_id AS to_id
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.from_item_id
       JOIN content_item other ON other.id = r.to_item_id
      WHERE r.from_item_id IN (${placeholders})
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}

      UNION ALL

     SELECT other.id, other.kind, other.title,
            p.inverse_label, 'asserted',
            r.from_item_id, r.to_item_id
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.to_item_id
       JOIN content_item other ON other.id = r.from_item_id
      WHERE r.to_item_id IN (${placeholders})
        AND ${edge.sql} AND ${near.sql} AND ${far.sql}

      UNION ALL

     SELECT other.id, other.kind, other.title,
            'mentions', 'mentioned',
            m.from_item_id, m.to_item_id
       FROM mention m
       JOIN content_item ci ON ci.id = m.from_item_id
       JOIN content_item other ON other.id = m.to_item_id
      WHERE m.from_item_id IN (${placeholders})
        AND ${near.sql} AND ${far.sql}

      UNION ALL

     SELECT other.id, other.kind, other.title,
            'mentioned in', 'mentioned',
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
      ...ids,
      ...edge.params,
      ...near.params,
      ...far.params,
      ...ids,
      ...near.params,
      ...far.params,
      ...ids,
      ...near.params,
      ...far.params,
    ],
  );
}

/** Builds the neighbourhood around one item. */
export async function buildGraph(
  db: Pool | PoolConnection,
  centre: { id: number; kind: string; slug: string; title: string },
  viewer: Viewer,
  depth = 2,
): Promise<Graph> {
  const maxDepth = Math.min(Math.max(Math.trunc(depth), 1), MAX_DEPTH);

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
    const rows = await neighboursOf(db, frontier, viewer);
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
      const key = `${source}-${target}-${row.relation}-${row.label}`;
      if (!edges.has(key)) {
        edges.set(key, { source, target, label: row.label, relation: row.relation });
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

  return { centre: centre.id, nodes: [...nodes.values()], edges: kept, truncated };
}
