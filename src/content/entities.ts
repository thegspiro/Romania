/**
 * People, organizations, places and events.
 *
 * These four share everything that lives in `content_item` -- slug, title,
 * visibility, publishing, search -- and differ only in their detail table. So
 * the shared half is written once here and each kind contributes its own SQL
 * as literal strings in `DETAIL_SPECS`.
 *
 * No table or column name is ever interpolated from a value: the specs are
 * compile-time constants, which is what makes this reuse safe rather than a
 * dynamic query builder.
 *
 * Every read takes a `Viewer` and goes through `visibilityFilter`, exactly as
 * `sources.ts` does.
 */
import type { RowDataPacket } from 'mysql2/promise';
import {
  execute,
  limitOffsetClause,
  queryOne,
  queryRows,
  withTransaction,
  type Pool,
  type PoolConnection,
  type SqlParam,
} from '../db/pool.js';
import { slugify, uniqueSlug } from './slug.js';
import { visibilityFilter, type Viewer, type Visibility } from './visibility.js';
import { referenceHref } from './references.js';
import { rebuildReferences, type RebuildResult } from './mentions.js';
import { isDatePrecision, type DatePrecision } from './timeline.js';

export const ENTITY_KINDS = ['person', 'organization', 'place', 'event'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && (ENTITY_KINDS as readonly string[]).includes(value);
}

export const ENTITY_LABELS: Readonly<Record<EntityKind, { singular: string; plural: string }>> =
  Object.freeze({
    person: { singular: 'Person', plural: 'People' },
    organization: { singular: 'Organization', plural: 'Organizations' },
    place: { singular: 'Place', plural: 'Places' },
    event: { singular: 'Event', plural: 'Events' },
  });

export interface EntityBase {
  id: number;
  kind: EntityKind;
  slug: string;
  title: string;
  titleOriginal: string | null;
  language: string | null;
  summary: string | null;
  visibility: Visibility;
  noindex: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  href: string;
}

/** Detail fields, flat and stringly-typed the way an HTML form posts them. */
export type EntityDetail = Record<string, string | number | null>;

export interface EntityRecord extends EntityBase {
  detail: EntityDetail;
}

export interface EntityInput {
  title: string;
  titleOriginal: string;
  language: string;
  summary: string;
  visibility: Visibility;
  noindex: boolean;
  /** Detail fields as posted; each spec reads only the keys it knows. */
  detail: Record<string, string>;
}

interface DetailSpec {
  /** Columns to select, already qualified with the alias `d`. */
  select: string;
  join: string;
  insert: string;
  update: string;
  /** Detail values in the order the insert/update expect them. */
  params: (input: Record<string, string>, connection: PoolConnection) => Promise<SqlParam[]>;
  fromRow: (row: RowDataPacket) => EntityDetail;
  /** Extra columns searched by the admin listing, qualified with `d`. */
  searchColumns: string[];
  /**
   * The kind's Markdown body, if it has one.
   *
   * Its references are projected into `mention` and `citation` exactly as an
   * essay's are. Only one column per kind: the projection is rebuilt wholesale
   * from one string, and a mention's context and paragraph anchor have to point
   * somewhere definite.
   */
  prose?: (input: Record<string, string>) => string;
}

function text(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parses a coordinate.
 *
 * Returns undefined for a blank field and null for something unparseable, so
 * the caller can tell "left empty" from "typed nonsense" -- the schema's CHECK
 * constraint requires latitude and longitude to be present together.
 */
function coordinate(value: string | undefined, bound: number): number | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > bound) return null;
  return parsed;
}

function isoDate(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * A clock time from the form, as 'HH:MM'.
 *
 * Anything else is discarded rather than rejected, the same way `isoDate`
 * treats a malformed date: a blank field and a typo both mean "no time was
 * recorded", and neither should stop the event being saved.
 */
function clockTime(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (match === null) return null;

  const [, hour, minute] = match;
  if (hour === undefined || minute === undefined) return null;
  if (Number(hour) > 23 || Number(minute) > 59) return null;

  return `${hour.padStart(2, '0')}:${minute}`;
}

/** A posted checkbox: present and not "off" means checked. */
function readBoolean(value: string | undefined): boolean {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed !== '' && trimmed !== '0' && trimmed !== 'off' && trimmed !== 'false';
}

/** A date precision from the form, whitelisted against the column's ENUM. */
function precisionOr(
  value: string | undefined,
  fallback: DatePrecision = 'unknown',
): DatePrecision {
  return isDatePrecision(value) ? value : fallback;
}

const DETAIL_SPECS: Readonly<Record<EntityKind, DetailSpec>> = Object.freeze({
  person: agentSpec(),
  organization: agentSpec(),
  place: {
    select:
      'd.latitude, d.longitude, d.geocode_precision, d.geocoded_at, d.country_code, ' +
      'd.admin_area, d.historical_names',
    join: 'LEFT JOIN place_detail d ON d.content_item_id = ci.id',
    insert: `INSERT INTO place_detail
               (content_item_id, latitude, longitude, geocode_precision, country_code,
                admin_area, historical_names)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
    update: `UPDATE place_detail
                SET latitude = ?, longitude = ?, geocode_precision = ?, country_code = ?,
                    admin_area = ?, historical_names = ?
              WHERE content_item_id = ?`,
    params: (input) => {
      const latitude = coordinate(input.latitude, 90);
      const longitude = coordinate(input.longitude, 180);
      // The CHECK constraint requires both or neither; a lone coordinate is
      // discarded here rather than rejected by the database with a message
      // the operator cannot act on.
      const paired = latitude !== null && longitude !== null;
      const precision = ['exact', 'approximate', 'region', 'unknown'].includes(
        input.geocodePrecision ?? '',
      )
        ? (input.geocodePrecision as string)
        : 'unknown';
      return Promise.resolve([
        paired ? latitude : null,
        paired ? longitude : null,
        precision,
        text(input.countryCode)?.slice(0, 2).toUpperCase() ?? null,
        text(input.adminArea),
        text(input.historicalNames),
      ]);
    },
    fromRow: (row) => ({
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      geocodePrecision: (row.geocode_precision as string) ?? 'unknown',
      geocodedAt: row.geocoded_at === null ? null : String(row.geocoded_at),
      countryCode: (row.country_code as string | null) ?? null,
      adminArea: (row.admin_area as string | null) ?? null,
      historicalNames: (row.historical_names as string | null) ?? null,
    }),
    searchColumns: ['d.admin_area', 'd.historical_names'],
  },
  event: {
    select:
      'd.start_date, d.end_date, d.start_time, d.end_time, d.date_precision, ' +
      'd.start_precision, d.end_precision, d.is_circa, d.body_markdown, d.place_item_id',
    join: 'LEFT JOIN event_detail d ON d.content_item_id = ci.id',
    insert: `INSERT INTO event_detail
               (content_item_id, start_date, end_date, start_time, end_time, date_precision,
                start_precision, end_precision, is_circa, body_markdown, place_item_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    update: `UPDATE event_detail
                SET start_date = ?, end_date = ?, start_time = ?, end_time = ?,
                    date_precision = ?, start_precision = ?, end_precision = ?,
                    is_circa = ?, body_markdown = ?, place_item_id = ?
              WHERE content_item_id = ?`,
    params: async (input, connection) => {
      const startPrecision = precisionOr(input.startPrecision ?? input.datePrecision);
      // An endpoint left blank inherits the start's precision: "June 1943 to
      // August 1944" is one statement about how well the range is known, and
      // making the operator say it twice invites them to say it wrong.
      const endPrecision = precisionOr(input.endPrecision, startPrecision);

      // The form names a place by slug; an unknown slug becomes no place
      // rather than a foreign key error the operator cannot interpret.
      let placeId: number | null = null;
      const placeSlug = text(input.placeSlug);
      if (placeSlug !== null) {
        const row = await queryOne<RowDataPacket & { id: number }>(
          connection,
          `SELECT id FROM content_item WHERE kind = 'place' AND slug = ?`,
          [placeSlug],
        );
        placeId = row?.id ?? null;
      }

      const start = isoDate(input.startDate);
      const end = isoDate(input.endDate);
      // The CHECK constraint requires end >= start; swapping is friendlier
      // than refusing, and the operator sees the result immediately.
      const swap = start !== null && end !== null && end < start;
      const ordered = swap ? [end, start] : [start, end];
      // The times travel with the dates they belong to, or the swap above
      // would leave 14:30 attached to the wrong endpoint.
      const startTime = clockTime(input.startTime);
      const endTime = clockTime(input.endTime);
      const orderedTimes = swap ? [endTime, startTime] : [startTime, endTime];

      return [
        ordered[0] ?? null,
        ordered[1] ?? null,
        orderedTimes[0] ?? null,
        orderedTimes[1] ?? null,
        // `date_precision` predates the per-endpoint pair and is still read by
        // anything written before them. Keeping it equal to the start's
        // precision keeps it a true answer to the question it always answered,
        // and is what makes migration 0007's backfill safe to re-run.
        startPrecision,
        startPrecision,
        endPrecision,
        readBoolean(input.isCirca) ? 1 : 0,
        text(input.bodyMarkdown),
        placeId,
      ];
    },
    fromRow: (row) => ({
      startDate: row.start_date === null ? null : String(row.start_date).slice(0, 10),
      endDate: row.end_date === null ? null : String(row.end_date).slice(0, 10),
      // TIME comes back as 'HH:MM:SS'; the form field takes 'HH:MM'.
      startTime: row.start_time === null ? null : String(row.start_time).slice(0, 5),
      endTime: row.end_time === null ? null : String(row.end_time).slice(0, 5),
      datePrecision: (row.date_precision as string) ?? 'unknown',
      startPrecision: (row.start_precision as string) ?? 'unknown',
      endPrecision: (row.end_precision as string) ?? 'unknown',
      isCirca: row.is_circa === 1 ? 1 : 0,
      bodyMarkdown: (row.body_markdown as string | null) ?? null,
      placeItemId: row.place_item_id === null ? null : Number(row.place_item_id),
    }),
    searchColumns: ['d.body_markdown'],
    prose: (input) => input.bodyMarkdown ?? '',
  },
});

function agentSpec(): DetailSpec {
  return {
    select:
      'd.family_name, d.given_name, d.alternate_names, d.birth_date, d.death_date, ' +
      'd.founded_date, d.dissolved_date, d.occupation, d.biography',
    join: 'LEFT JOIN agent_detail d ON d.content_item_id = ci.id',
    insert: `INSERT INTO agent_detail
               (content_item_id, family_name, given_name, alternate_names, birth_date,
                death_date, founded_date, dissolved_date, occupation, biography)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    update: `UPDATE agent_detail
                SET family_name = ?, given_name = ?, alternate_names = ?, birth_date = ?,
                    death_date = ?, founded_date = ?, dissolved_date = ?, occupation = ?,
                    biography = ?
              WHERE content_item_id = ?`,
    params: (input) =>
      Promise.resolve([
        text(input.familyName),
        text(input.givenName),
        text(input.alternateNames),
        text(input.birthDate),
        text(input.deathDate),
        text(input.foundedDate),
        text(input.dissolvedDate),
        text(input.occupation),
        text(input.biography),
      ]),
    fromRow: (row) => ({
      familyName: (row.family_name as string | null) ?? null,
      givenName: (row.given_name as string | null) ?? null,
      alternateNames: (row.alternate_names as string | null) ?? null,
      birthDate: (row.birth_date as string | null) ?? null,
      deathDate: (row.death_date as string | null) ?? null,
      foundedDate: (row.founded_date as string | null) ?? null,
      dissolvedDate: (row.dissolved_date as string | null) ?? null,
      occupation: (row.occupation as string | null) ?? null,
      biography: (row.biography as string | null) ?? null,
    }),
    searchColumns: ['d.alternate_names', 'd.occupation'],
    // The biography is Markdown and the editor offers the reference picker for
    // it, so its references are indexed like any other prose.
    prose: (input) => input.biography ?? '',
  };
}

const BASE_COLUMNS = `
  ci.id, ci.kind, ci.slug, ci.title, ci.title_original, ci.language, ci.summary,
  ci.visibility, ci.noindex, ci.published_at, ci.created_at, ci.updated_at
`;

function toBase(row: RowDataPacket): EntityBase {
  const kind = row.kind as EntityKind;
  return {
    id: Number(row.id),
    kind,
    slug: String(row.slug),
    title: String(row.title),
    titleOriginal: (row.title_original as string | null) ?? null,
    language: (row.language as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    visibility: row.visibility as Visibility,
    noindex: row.noindex === 1,
    publishedAt: (row.published_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    href: referenceHref(kind, String(row.slug)),
  };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// --- Reads -----------------------------------------------------------------

export async function findEntityBySlug(
  db: Pool | PoolConnection,
  kind: EntityKind,
  slug: string,
  viewer: Viewer,
): Promise<EntityRecord | null> {
  const spec = DETAIL_SPECS[kind];
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${BASE_COLUMNS}, ${spec.select}
       FROM content_item ci ${spec.join}
      WHERE ci.kind = ? AND ci.slug = ? AND ${visible.sql}`,
    [kind, slug, ...visible.params],
  );
  return row === null ? null : { ...toBase(row), detail: spec.fromRow(row) };
}

export async function findEntityById(
  db: Pool | PoolConnection,
  kind: EntityKind,
  id: number,
  viewer: Viewer,
): Promise<EntityRecord | null> {
  const spec = DETAIL_SPECS[kind];
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${BASE_COLUMNS}, ${spec.select}
       FROM content_item ci ${spec.join}
      WHERE ci.kind = ? AND ci.id = ? AND ${visible.sql}`,
    [kind, id, ...visible.params],
  );
  return row === null ? null : { ...toBase(row), detail: spec.fromRow(row) };
}

export interface ListEntitiesOptions {
  search?: string | undefined;
  visibility?: Visibility | undefined;
  limit?: number;
  offset?: number;
}

export async function listEntities(
  db: Pool | PoolConnection,
  kind: EntityKind,
  viewer: Viewer,
  options: ListEntitiesOptions = {},
): Promise<{ items: EntityBase[]; total: number }> {
  const spec = DETAIL_SPECS[kind];
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const visible = visibilityFilter(viewer, 'ci');
  const conditions = ['ci.kind = ?', visible.sql];
  const params: SqlParam[] = [kind, ...visible.params];

  const search = options.search?.trim();
  if (search !== undefined && search !== '') {
    const pattern = `%${escapeLike(search)}%`;
    const columns = ['ci.title', 'ci.title_original', 'ci.summary', ...spec.searchColumns];
    conditions.push(`(${columns.map((column) => `${column} LIKE ? ESCAPE '\\\\'`).join(' OR ')})`);
    params.push(...columns.map(() => pattern));
  }

  // Only an administrator may filter by visibility; for anyone else the
  // filter is already fixed to 'public' and honouring the parameter would
  // turn it into a way to probe for private rows.
  if (options.visibility !== undefined && viewer.kind === 'admin') {
    conditions.push('ci.visibility = ?');
    params.push(options.visibility);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const totalRow = await queryOne<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(*) AS total FROM content_item ci ${spec.join} ${where}`,
    params,
  );

  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT ${BASE_COLUMNS} FROM content_item ci ${spec.join} ${where}
      ORDER BY ci.title ASC, ci.id ASC
      ${limitOffsetClause(limit, offset)}`,
    params,
  );

  return { items: rows.map(toBase), total: Number(totalRow?.total ?? 0) };
}

/** Type-ahead for the editor's reference picker. Administrator only. */
export async function searchAllEntities(
  db: Pool | PoolConnection,
  viewer: Viewer,
  query: string,
  kinds: readonly string[],
  limit = 20,
): Promise<{ id: number; kind: string; slug: string; title: string; visibility: Visibility }[]> {
  const trimmed = query.trim();
  if (trimmed === '' || kinds.length === 0) return [];

  const visible = visibilityFilter(viewer, 'ci');
  const pattern = `%${escapeLike(trimmed)}%`;
  // Placeholders only; every kind is bound as a parameter.
  const kindPlaceholders = kinds.map(() => '?').join(', ');

  return queryRows<
    RowDataPacket & {
      id: number;
      kind: string;
      slug: string;
      title: string;
      visibility: Visibility;
    }
  >(
    db,
    `SELECT ci.id, ci.kind, ci.slug, ci.title, ci.visibility
       FROM content_item ci
      WHERE ci.kind IN (${kindPlaceholders})
        AND ${visible.sql}
        AND (ci.title LIKE ? ESCAPE '\\\\' OR ci.title_original LIKE ? ESCAPE '\\\\')
      ORDER BY ci.title ASC
      ${limitOffsetClause(Math.min(Math.max(limit, 1), 50))}`,
    [...kinds, ...visible.params, pattern, pattern],
  );
}

// --- Writes ----------------------------------------------------------------

/**
 * The result of a write that also rebuilt projections.
 *
 * Mirrors `EssayWriteResult`: the caller shows the operator which references
 * point at nothing and which cited sources are still private, before the page
 * is published rather than after.
 */
export interface EntityWriteResult {
  id: number;
  references: RebuildResult | null;
}

/**
 * Rebuilds an entity's projections from its prose, in the caller's transaction.
 *
 * Returns null for a kind that has no body. The transaction is the caller's on
 * purpose: the rows and the text they describe must commit together, so a
 * listing can never describe a version of the prose that was never saved.
 */
async function rebuildEntityProse(
  connection: PoolConnection,
  spec: DetailSpec,
  id: number,
  input: EntityInput,
): Promise<RebuildResult | null> {
  if (spec.prose === undefined) return null;
  return rebuildReferences(connection, id, spec.prose(input.detail));
}

export async function createEntity(
  pool: Pool,
  kind: EntityKind,
  input: EntityInput,
): Promise<EntityWriteResult> {
  const spec = DETAIL_SPECS[kind];

  return withTransaction(pool, async (connection) => {
    const slug = await uniqueSlug(
      slugify(input.title),
      async (candidate) => {
        const row = await queryOne<RowDataPacket & { id: number }>(
          connection,
          'SELECT id FROM content_item WHERE kind = ? AND slug = ?',
          [kind, candidate],
        );
        return row !== null;
      },
      kind,
    );

    const result = await execute(
      connection,
      `INSERT INTO content_item
         (kind, slug, title, title_original, language, summary, visibility, noindex, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        kind,
        slug,
        input.title.trim(),
        text(input.titleOriginal),
        text(input.language),
        text(input.summary),
        input.visibility,
        input.noindex ? 1 : 0,
        input.visibility === 'public' ? new Date() : null,
      ],
    );

    const id = result.insertId;
    await execute(connection, spec.insert, [id, ...(await spec.params(input.detail, connection))]);
    return { id, references: await rebuildEntityProse(connection, spec, id, input) };
  });
}

/**
 * Updates an entity.
 *
 * The slug is deliberately not regenerated when the title changes: pages are
 * meant to be linked and cited by URL, and every `[[person:slug]]` reference
 * in existing prose is keyed to it.
 */
export async function updateEntity(
  pool: Pool,
  kind: EntityKind,
  id: number,
  input: EntityInput,
): Promise<EntityWriteResult | null> {
  const spec = DETAIL_SPECS[kind];

  return withTransaction(pool, async (connection) => {
    const existing = await queryOne<RowDataPacket & { id: number }>(
      connection,
      'SELECT id FROM content_item WHERE id = ? AND kind = ? FOR UPDATE',
      [id, kind],
    );
    if (existing === null) return null;

    await execute(
      connection,
      `UPDATE content_item
          SET title = ?, title_original = ?, language = ?, summary = ?,
              visibility = ?, noindex = ?,
              published_at = CASE
                WHEN ? = 'public' AND published_at IS NULL THEN NOW(3)
                ELSE published_at
              END
        WHERE id = ?`,
      [
        input.title.trim(),
        text(input.titleOriginal),
        text(input.language),
        text(input.summary),
        input.visibility,
        input.noindex ? 1 : 0,
        input.visibility,
        id,
      ],
    );

    const detailParams = await spec.params(input.detail, connection);
    const updated = await execute(connection, spec.update, [...detailParams, id]);
    // A row created before its detail table existed, or one whose detail was
    // removed: insert rather than silently saving nothing.
    if (updated.affectedRows === 0) {
      await execute(connection, spec.insert, [id, ...detailParams]);
    }

    return { id, references: await rebuildEntityProse(connection, spec, id, input) };
  });
}

export async function setEntityVisibility(
  db: Pool | PoolConnection,
  kind: EntityKind,
  id: number,
  visibility: Visibility,
): Promise<boolean> {
  const result = await execute(
    db,
    `UPDATE content_item
        SET visibility = ?,
            published_at = CASE
              WHEN ? = 'public' AND published_at IS NULL THEN NOW(3)
              ELSE published_at
            END
      WHERE id = ? AND kind = ?`,
    [visibility, visibility, id, kind],
  );
  return result.affectedRows > 0;
}

/**
 * Deletes an entity.
 *
 * Returns 'referenced' when prose still names it. The `mention` and `citation`
 * foreign keys are RESTRICT, so the database would refuse anyway; checking
 * first turns a constraint error into a message naming what to edit.
 */
export async function deleteEntity(
  pool: Pool,
  kind: EntityKind,
  id: number,
): Promise<'deleted' | 'not_found' | 'referenced'> {
  return withTransaction(pool, async (connection) => {
    const referenced = await queryOne<RowDataPacket & { total: number }>(
      connection,
      `SELECT (SELECT COUNT(*) FROM mention WHERE to_item_id = ?)
            + (SELECT COUNT(*) FROM citation WHERE source_item_id = ?) AS total`,
      [id, id],
    );
    if (Number(referenced?.total ?? 0) > 0) return 'referenced';

    const result = await execute(connection, 'DELETE FROM content_item WHERE id = ? AND kind = ?', [
      id,
      kind,
    ]);
    return result.affectedRows > 0 ? 'deleted' : 'not_found';
  });
}
