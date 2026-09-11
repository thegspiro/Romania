/**
 * Typed relationships between entities.
 *
 * These are the edges the operator asserts deliberately -- "member of",
 * "born in" -- as distinct from mentions, which are derived from prose. Both
 * feed the network graph; only these are editable.
 *
 * An edge may also carry the *role* it was held in and the *period* it held
 * for: "Minister of the Interior, 1940-1941". Those belong on the edge rather
 * than on either endpoint, because an office is a property of the connection.
 * Two offices at the same organization are two edges, which is why the unique
 * key includes the generated `period_key` (see 0006_relationship_roles).
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

/** Longest role title the column accepts. */
export const MAX_ROLE_TITLE = 255;

/**
 * How precisely an office's period is known. Named apart from `timeline.ts`.
 *
 * The two vocabularies genuinely differ -- an office does not begin at 14:30,
 * so this ladder stops at 'day' -- but until now both modules exported
 * `DatePrecision`, `DATE_PRECISIONS` and `isDatePrecision` with different
 * member sets, so `isDatePrecision('hour')` was true or false depending on
 * which file you had imported. Two vocabularies, two names.
 */
export const PERIOD_PRECISIONS = ['day', 'month', 'year', 'decade', 'unknown'] as const;
export type PeriodPrecision = (typeof PERIOD_PRECISIONS)[number];

export function isPeriodPrecision(value: unknown): value is PeriodPrecision {
  return typeof value === 'string' && (PERIOD_PRECISIONS as readonly string[]).includes(value);
}

/**
 * How much of a stored date is actually known.
 *
 * Same contract as `event_detail`: a date stored as 1944-01-01 with precision
 * 'year' means "1944", not "1 January 1944". 'unknown' is rendered as a year
 * too, because the year is the least that can be claimed from the value.
 */
export interface RelationshipPeriod {
  /** ISO 8601 calendar date, or null. */
  startDate: string | null;
  endDate: string | null;
  precision: PeriodPrecision;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Accepts only what the DATE column can hold, and only in one shape. */
export function isoDate(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * A DATE column read back through mysql2, as an ISO date.
 *
 * The driver returns a `Date` built at UTC midnight (the pool sets
 * `timezone: 'Z'`), so the ISO form is exact rather than shifted by the
 * container's local zone.
 */
export function columnToIsoDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // Narrowed rather than stringified: `unknown` covers a driver configured
  // with `dateStrings`, and anything else is simply not a date.
  if (typeof value !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/** One end of a period, rendered to the precision claimed for it. */
function formatEndpoint(iso: string, precision: PeriodPrecision): string {
  const year = iso.slice(0, 4);
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));

  switch (precision) {
    case 'day':
      return `${day} ${MONTH_NAMES[month - 1] ?? ''} ${year}`.replace(/\s+/g, ' ').trim();
    case 'month':
      return `${MONTH_NAMES[month - 1] ?? ''} ${year}`.trim();
    case 'decade':
      return `${year.slice(0, 3)}0s`;
    // A year is all that can be claimed from a date of unstated precision.
    case 'year':
    case 'unknown':
    default:
      return year;
  }
}

/**
 * A period as prose: "1940-1941", "September 1940", "from 1944".
 *
 * Returns null when neither end is known, so a caller can omit the whole
 * fragment rather than print an empty range.
 */
export function formatPeriod(period: RelationshipPeriod): string | null {
  const start =
    period.startDate === null ? null : formatEndpoint(period.startDate, period.precision);
  const end = period.endDate === null ? null : formatEndpoint(period.endDate, period.precision);

  if (start === null && end === null) return null;

  // "from the 1930s" reads; "from 1930s" does not.
  const article = period.precision === 'decade' ? 'the ' : '';
  if (start !== null && end === null) return `from ${article}${start}`;
  if (start === null && end !== null) return `until ${article}${end}`;
  if (start === end) return start;

  // Spaced en dash only when an endpoint already contains a space, which is
  // the usual typographic rule and keeps "1940-1941" tight.
  const separator = `${start}${end}`.includes(' ') ? ' – ' : '–';
  return `${start}${separator}${end}`;
}

/**
 * How one edge reads on a drawing or in a list.
 *
 * The role takes the headline when there is one: "Prime Minister, 1941-1944"
 * says more than "Held office in".
 */
export function edgeLabel(label: string, roleTitle: string | null, period: string | null): string {
  const head = roleTitle !== null && roleTitle !== '' ? roleTitle : label;
  return period === null ? head : `${head}, ${period}`;
}

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
  /** The office or capacity the edge was held in, if one was recorded. */
  roleTitle: string | null;
  period: RelationshipPeriod;
  /** The period as prose, or null when neither end is known. */
  periodLabel: string | null;
  /** Role and period folded into the label, as the drawing shows it. */
  display: string;
  note: string | null;
  visibility: Visibility;
  /** True when this page is the `to` end, so the label was inverted. */
  inverted: boolean;
  other: { id: number; kind: string; slug: string; title: string; href: string };
}

interface RelationshipRow extends RowDataPacket {
  id: number;
  label: string;
  inverse_label: string;
  role_title: string | null;
  start_date: unknown;
  end_date: unknown;
  date_precision: string;
  note: string | null;
  visibility: Visibility;
  inverted: number;
  other_id: number;
  other_kind: string;
  other_slug: string;
  other_title: string;
}

function toRelationshipView(row: RelationshipRow): RelationshipView {
  const label = row.inverted === 1 ? row.inverse_label : row.label;
  const period: RelationshipPeriod = {
    startDate: columnToIsoDate(row.start_date),
    endDate: columnToIsoDate(row.end_date),
    precision: isPeriodPrecision(row.date_precision) ? row.date_precision : 'unknown',
  };
  const periodLabel = formatPeriod(period);

  return {
    id: Number(row.id),
    label,
    roleTitle: row.role_title,
    period,
    periodLabel,
    display: edgeLabel(label, row.role_title, periodLabel),
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
  };
}

/**
 * Every visible relationship touching an item, in both directions.
 *
 * The visibility test is applied three times over -- to the edge and to both
 * endpoints -- because any one of them being private is enough to make the
 * edge undisclosable.
 *
 * Dated edges are ordered earliest first within a label, so a career reads in
 * sequence; undated ones follow, because "no date recorded" is not "earliest".
 */
export async function listRelationshipsFor(
  db: Pool | PoolConnection,
  itemId: number,
  viewer: Viewer,
): Promise<RelationshipView[]> {
  const edge = visibilityFilter(viewer, 'r');
  const near = visibilityFilter(viewer, 'ci');
  const far = visibilityFilter(viewer, 'other');

  const rows = await queryRows<RelationshipRow>(
    db,
    `SELECT r.id, p.label, p.inverse_label, r.role_title, r.start_date, r.end_date,
            r.date_precision, r.note, r.visibility, 0 AS inverted,
            other.id AS other_id, other.kind AS other_kind,
            other.slug AS other_slug, other.title AS other_title
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.from_item_id
       JOIN content_item other ON other.id = r.to_item_id
      WHERE r.from_item_id = ? AND ${edge.sql} AND ${near.sql} AND ${far.sql}
      UNION ALL
     SELECT r.id, p.label, p.inverse_label, r.role_title, r.start_date, r.end_date,
            r.date_precision, r.note, r.visibility, 1 AS inverted,
            other.id AS other_id, other.kind AS other_kind,
            other.slug AS other_slug, other.title AS other_title
       FROM relationship r
       JOIN relationship_predicate p ON p.id = r.predicate_id
       JOIN content_item ci ON ci.id = r.to_item_id
       JOIN content_item other ON other.id = r.from_item_id
      WHERE r.to_item_id = ? AND ${edge.sql} AND ${near.sql} AND ${far.sql}
      ORDER BY label, start_date IS NULL, start_date, other_title`,
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

  return rows.map(toRelationshipView);
}

export interface CreateRelationshipInput {
  fromItemId: number;
  toItemId: number;
  predicateId: number;
  /** Office or capacity; blank and whitespace-only both mean "none". */
  roleTitle?: string | null;
  /** ISO 8601 calendar dates. Anything else is read as "not recorded". */
  startDate?: string | null;
  endDate?: string | null;
  datePrecision?: PeriodPrecision;
  note: string | null;
  visibility: Visibility;
}

export type CreateRelationshipOutcome =
  | { ok: true; id: number }
  | {
      ok: false;
      reason: 'self' | 'duplicate' | 'unknown_item' | 'unknown_predicate' | 'role_too_long';
    };

/**
 * Normalises the qualifying fields to what the columns accept.
 *
 * A malformed date becomes "not recorded" rather than an error, and a
 * reversed range is swapped, both matching how `event_detail` treats the same
 * fields in `entities.ts`: the operator sees the result immediately on the
 * page, and refusing the whole save over a typo helps nobody.
 */
function normaliseQualifier(input: CreateRelationshipInput): {
  roleTitle: string | null;
  startDate: string | null;
  endDate: string | null;
  precision: PeriodPrecision;
} {
  const roleTitle = (input.roleTitle ?? '').trim() || null;
  const start = isoDate(input.startDate);
  const end = isoDate(input.endDate);
  const reversed = start !== null && end !== null && end < start;

  return {
    roleTitle,
    startDate: reversed ? end : start,
    endDate: reversed ? start : end,
    precision: isPeriodPrecision(input.datePrecision) ? input.datePrecision : 'unknown',
  };
}

export async function createRelationship(
  db: Pool | PoolConnection,
  input: CreateRelationshipInput,
): Promise<CreateRelationshipOutcome> {
  if (input.fromItemId === input.toItemId) return { ok: false, reason: 'self' };

  const qualifier = normaliseQualifier(input);
  if (qualifier.roleTitle !== null && qualifier.roleTitle.length > MAX_ROLE_TITLE) {
    return { ok: false, reason: 'role_too_long' };
  }

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

  // Two edges between the same pair are the same edge only when the office
  // and the period match as well -- the same comparison the unique key makes,
  // written here so the operator gets a message instead of a driver error.
  // NULL-safe equality, because <=> is what the generated key folds to.
  const existing = await queryOne<RowDataPacket & { id: number }>(
    db,
    `SELECT id FROM relationship
      WHERE from_item_id = ? AND predicate_id = ? AND to_item_id = ?
        AND role_title <=> ? AND start_date <=> ? AND end_date <=> ?`,
    [
      input.fromItemId,
      input.predicateId,
      input.toItemId,
      qualifier.roleTitle,
      qualifier.startDate,
      qualifier.endDate,
    ],
  );
  if (existing !== null) return { ok: false, reason: 'duplicate' };

  const result = await execute(
    db,
    `INSERT INTO relationship
       (from_item_id, to_item_id, predicate_id, role_title, start_date, end_date,
        date_precision, note, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.fromItemId,
      input.toItemId,
      input.predicateId,
      qualifier.roleTitle,
      qualifier.startDate,
      qualifier.endDate,
      qualifier.precision,
      input.note,
      input.visibility,
    ],
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
