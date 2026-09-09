/**
 * Typed relationships between entities.
 *
 * These are the edges the operator asserts deliberately -- "member of",
 * "born in" -- as distinct from mentions, which are derived from prose. Both
 * feed the network graph; only these are editable.
 *
 * An edge carries its own visibility, because the relationship between two
 * people can be more sensitive than either person's page. A public edge is
 * shown only when both endpoints are also visible: an edge whose other end is
 * private would disclose that the other end exists.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { execute, queryOne, queryRows, type Pool, type PoolConnection } from '../db/pool.js';
import { visibilityFilter, type Viewer, type Visibility } from './visibility.js';
import { referenceHref } from './references.js';

export interface Predicate {
  id: number;
  code: string;
  label: string;
  inverseLabel: string;
  isSymmetric: boolean;
}

export async function listPredicates(db: Pool | PoolConnection): Promise<Predicate[]> {
  const rows = await queryRows<
    RowDataPacket & {
      id: number;
      code: string;
      label: string;
      inverse_label: string;
      is_symmetric: number;
    }
  >(
    db,
    'SELECT id, code, label, inverse_label, is_symmetric FROM relationship_predicate ORDER BY label',
  );

  return rows.map((row) => ({
    id: Number(row.id),
    code: row.code,
    label: row.label,
    inverseLabel: row.inverse_label,
    isSymmetric: row.is_symmetric === 1,
  }));
}

export interface RelationshipView {
  id: number;
  /** Reads correctly from the page being viewed, using the inverse where needed. */
  label: string;
  note: string | null;
  visibility: Visibility;
  /** True when this page is the `to` end, so the label was inverted. */
  inverted: boolean;
  other: { id: number; kind: string; slug: string; title: string; href: string };
}

/**
 * Every visible relationship touching an item, in both directions.
 *
 * The visibility test is applied three times over -- to the edge and to both
 * endpoints -- because any one of them being private is enough to make the
 * edge undisclosable.
 */
export async function listRelationshipsFor(
  db: Pool | PoolConnection,
  itemId: number,
  viewer: Viewer,
): Promise<RelationshipView[]> {
  const edge = visibilityFilter(viewer, 'r');
  const near = visibilityFilter(viewer, 'ci');
  const far = visibilityFilter(viewer, 'other');

  const rows = await queryRows<
    RowDataPacket & {
      id: number;
      label: string;
      inverse_label: string;
      note: string | null;
      visibility: Visibility;
      inverted: number;
      other_id: number;
      other_kind: string;
      other_slug: string;
      other_title: string;
    }
  >(
    db,
    `SELECT r.id, p.label, p.inverse_label, r.note, r.visibility, 0 AS inverted,
            other.id AS other_id, other.kind AS other_kind,
            other.slug AS other_slug, other.title AS other_title
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.from_item_id
       JOIN content_item other ON other.id = r.to_item_id
      WHERE r.from_item_id = ? AND ${edge.sql} AND ${near.sql} AND ${far.sql}
      UNION ALL
     SELECT r.id, p.label, p.inverse_label, r.note, r.visibility, 1 AS inverted,
            other.id AS other_id, other.kind AS other_kind,
            other.slug AS other_slug, other.title AS other_title
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.to_item_id
       JOIN content_item other ON other.id = r.from_item_id
      WHERE r.to_item_id = ? AND ${edge.sql} AND ${near.sql} AND ${far.sql}
      ORDER BY label, other_title`,
    [
      itemId,
      ...edge.params,
      ...near.params,
      ...far.params,
      itemId,
      ...edge.params,
      ...near.params,
      ...far.params,
    ],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    label: row.inverted === 1 ? row.inverse_label : row.label,
    note: row.note,
    visibility: row.visibility,
    inverted: row.inverted === 1,
    other: {
      id: Number(row.other_id),
      kind: row.other_kind,
      slug: row.other_slug,
      title: row.other_title,
      href: referenceHref(row.other_kind, row.other_slug),
    },
  }));
}

export interface CreateRelationshipInput {
  fromItemId: number;
  toItemId: number;
  predicateId: number;
  note: string | null;
  visibility: Visibility;
}

export type CreateRelationshipOutcome =
  | { ok: true; id: number }
  | { ok: false; reason: 'self' | 'duplicate' | 'unknown_item' | 'unknown_predicate' };

export async function createRelationship(
  db: Pool | PoolConnection,
  input: CreateRelationshipInput,
): Promise<CreateRelationshipOutcome> {
  if (input.fromItemId === input.toItemId) return { ok: false, reason: 'self' };

  const target = await queryOne<RowDataPacket & { id: number }>(
    db,
    'SELECT id FROM content_item WHERE id = ?',
    [input.toItemId],
  );
  if (target === null) return { ok: false, reason: 'unknown_item' };

  const predicate = await queryOne<RowDataPacket & { id: number }>(
    db,
    'SELECT id FROM relationship_predicate WHERE id = ?',
    [input.predicateId],
  );
  if (predicate === null) return { ok: false, reason: 'unknown_predicate' };

  const existing = await queryOne<RowDataPacket & { id: number }>(
    db,
    'SELECT id FROM relationship WHERE from_item_id = ? AND predicate_id = ? AND to_item_id = ?',
    [input.fromItemId, input.predicateId, input.toItemId],
  );
  if (existing !== null) return { ok: false, reason: 'duplicate' };

  const result = await execute(
    db,
    `INSERT INTO relationship (from_item_id, to_item_id, predicate_id, note, visibility)
     VALUES (?, ?, ?, ?, ?)`,
    [input.fromItemId, input.toItemId, input.predicateId, input.note, input.visibility],
  );
  return { ok: true, id: result.insertId };
}

export async function deleteRelationship(db: Pool | PoolConnection, id: number): Promise<boolean> {
  const result = await execute(db, 'DELETE FROM relationship WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

export async function setRelationshipVisibility(
  db: Pool | PoolConnection,
  id: number,
  visibility: Visibility,
): Promise<boolean> {
  const result = await execute(db, 'UPDATE relationship SET visibility = ? WHERE id = ?', [
    visibility,
    id,
  ]);
  return result.affectedRows > 0;
}
