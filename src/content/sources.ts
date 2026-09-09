/**
 * Repository for sources (the bibliography).
 *
 * A source is a `content_item` of kind 'source' plus a `source_detail` row.
 * The CSL-JSON in `source_detail.csl_json` is authoritative; the scalar
 * columns beside it (`container_title`, `issued_year`, `archive`, ...) are
 * derived copies maintained here on every write so that listing, sorting and
 * filtering do not have to open the JSON. They are never read back as truth.
 *
 * Every read takes a `Viewer` and applies `visibilityFilter`. See
 * `src/content/visibility.ts` for why that is centralised.
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
import {
  buildCslItem,
  issuedYear,
  parseStoredCslItem,
  type CslItem,
  type SourceFormInput,
} from '../citations/csl.js';
import { slugify, uniqueSlug } from './slug.js';
import { visibilityFilter, type Viewer, type Visibility } from './visibility.js';

export interface SourceSummary {
  id: number;
  slug: string;
  title: string;
  titleOriginal: string | null;
  language: string | null;
  visibility: Visibility;
  noindex: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  cslType: string;
  containerTitle: string | null;
  issuedYear: number | null;
  archive: string | null;
}

export interface SourceRecord extends SourceSummary {
  summary: string | null;
  csl: CslItem;
  archiveLocation: string | null;
  callNumber: string | null;
  url: string | null;
  accessedOn: Date | null;
  notes: string | null;
}

interface SourceRow extends RowDataPacket {
  id: number;
  slug: string;
  title: string;
  title_original: string | null;
  language: string | null;
  summary: string | null;
  visibility: Visibility;
  noindex: number;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  csl_type: string;
  csl_json: unknown;
  container_title: string | null;
  issued_year: number | null;
  archive: string | null;
  archive_location: string | null;
  call_number: string | null;
  url: string | null;
  accessed_on: Date | null;
  notes: string | null;
}

const SELECT_COLUMNS = `
  ci.id, ci.slug, ci.title, ci.title_original, ci.language, ci.summary,
  ci.visibility, ci.noindex, ci.published_at, ci.created_at, ci.updated_at,
  sd.csl_type, sd.csl_json, sd.container_title, sd.issued_year, sd.archive,
  sd.archive_location, sd.call_number, sd.url, sd.accessed_on, sd.notes
`;

const FROM_CLAUSE = `
  FROM content_item ci
  JOIN source_detail sd ON sd.content_item_id = ci.id
`;

function toRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    titleOriginal: row.title_original,
    language: row.language,
    summary: row.summary,
    visibility: row.visibility,
    noindex: row.noindex === 1,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cslType: row.csl_type,
    csl: parseStoredCslItem(row.csl_json),
    containerTitle: row.container_title,
    issuedYear: row.issued_year,
    archive: row.archive,
    archiveLocation: row.archive_location,
    callNumber: row.call_number,
    url: row.url,
    accessedOn: row.accessed_on,
    notes: row.notes,
  };
}

/**
 * Escapes a user-supplied LIKE pattern.
 *
 * Without this a search for "50%" matches everything, and "_" matches any
 * character. The backslash is declared with ESCAPE at the call site.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface ListSourcesOptions {
  search?: string | undefined;
  visibility?: Visibility | undefined;
  limit?: number;
  offset?: number;
}

export interface ListSourcesResult {
  items: SourceRecord[];
  total: number;
}

export async function listSources(
  db: Pool | PoolConnection,
  viewer: Viewer,
  options: ListSourcesOptions = {},
): Promise<ListSourcesResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const visible = visibilityFilter(viewer, 'ci');
  const conditions = [`ci.kind = 'source'`, visible.sql];
  const params: SqlParam[] = [...visible.params];

  const search = options.search?.trim();
  if (search !== undefined && search !== '') {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      `(ci.title LIKE ? ESCAPE '\\\\'
        OR ci.title_original LIKE ? ESCAPE '\\\\'
        OR ci.summary LIKE ? ESCAPE '\\\\'
        OR sd.container_title LIKE ? ESCAPE '\\\\'
        OR sd.archive LIKE ? ESCAPE '\\\\'
        OR sd.call_number LIKE ? ESCAPE '\\\\')`,
    );
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  // Only an administrator may filter by visibility; for anonymous viewers the
  // filter is already fixed to 'public' and honouring the parameter would let
  // a crafted query probe for private rows.
  if (options.visibility !== undefined && viewer.kind === 'admin') {
    conditions.push('ci.visibility = ?');
    params.push(options.visibility);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const totalRow = await queryOne<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(*) AS total ${FROM_CLAUSE} ${where}`,
    params,
  );

  const rows = await queryRows<SourceRow>(
    db,
    `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE} ${where}
     ORDER BY ci.title ASC, ci.id ASC
     ${limitOffsetClause(limit, offset)}`,
    params,
  );

  return { items: rows.map(toRecord), total: totalRow?.total ?? 0 };
}

export async function findSourceBySlug(
  db: Pool | PoolConnection,
  slug: string,
  viewer: Viewer,
): Promise<SourceRecord | null> {
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<SourceRow>(
    db,
    `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE}
      WHERE ci.kind = 'source' AND ci.slug = ? AND ${visible.sql}`,
    [slug, ...visible.params],
  );
  return row === null ? null : toRecord(row);
}

export async function findSourceById(
  db: Pool | PoolConnection,
  id: number,
  viewer: Viewer,
): Promise<SourceRecord | null> {
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<SourceRow>(
    db,
    `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE}
      WHERE ci.kind = 'source' AND ci.id = ? AND ${visible.sql}`,
    [id, ...visible.params],
  );
  return row === null ? null : toRecord(row);
}

// --- Writes ----------------------------------------------------------------

/** Form fields shared by create and update. */
export type SourceInput = Omit<SourceFormInput, 'id'> & {
  titleOriginal: string;
  summary: string;
  visibility: Visibility;
  noindex: boolean;
};

async function slugExists(
  db: Pool | PoolConnection,
  slug: string,
  excludingId: number | null,
): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { id: number }>(
    db,
    `SELECT id FROM content_item WHERE kind = 'source' AND slug = ? AND (? IS NULL OR id <> ?)`,
    [slug, excludingId, excludingId],
  );
  return row !== null;
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function accessedDate(input: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (match === null) return null;
  const date = new Date(`${input.trim()}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Creates a source and returns its id.
 *
 * The whole write is one transaction: a `content_item` without its
 * `source_detail` row would be an item with no bibliographic record, which
 * every read path would then have to defend against.
 */
export async function createSource(pool: Pool, input: SourceInput): Promise<number> {
  return withTransaction(pool, async (connection) => {
    const slug = await uniqueSlug(
      slugify(input.title),
      (candidate) => slugExists(connection, candidate, null),
      'source',
    );

    const csl = buildCslItem({ ...input, id: slug });
    const publishedAt = input.visibility === 'public' ? new Date() : null;

    const itemResult = await execute(
      connection,
      `INSERT INTO content_item
         (kind, slug, title, title_original, language, summary, visibility, noindex, published_at)
       VALUES ('source', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        input.title.trim(),
        optionalText(input.titleOriginal),
        optionalText(input.language),
        optionalText(input.summary),
        input.visibility,
        input.noindex ? 1 : 0,
        publishedAt,
      ],
    );

    const id = itemResult.insertId;

    await execute(
      connection,
      `INSERT INTO source_detail
         (content_item_id, csl_type, csl_json, container_title, issued_year,
          archive, archive_location, call_number, url, accessed_on, notes)
       VALUES (?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.cslType,
        JSON.stringify(csl),
        optionalText(input.containerTitle),
        issuedYear(csl),
        optionalText(input.archive),
        optionalText(input.archiveLocation),
        optionalText(input.callNumber),
        optionalText(input.url),
        accessedDate(input.accessed),
        optionalText(input.note),
      ],
    );

    return id;
  });
}

/**
 * Updates a source.
 *
 * The slug is deliberately not regenerated when the title changes. Public
 * source pages are meant to be cited by URL, and a citation that stops
 * resolving because a typo was fixed in the title is worse than a slug that
 * no longer matches its title exactly.
 */
export async function updateSource(pool: Pool, id: number, input: SourceInput): Promise<boolean> {
  return withTransaction(pool, async (connection) => {
    const existing = await queryOne<RowDataPacket & { slug: string; visibility: Visibility }>(
      connection,
      `SELECT slug, visibility FROM content_item WHERE id = ? AND kind = 'source' FOR UPDATE`,
      [id],
    );
    if (existing === null) return false;

    const csl = buildCslItem({ ...input, id: existing.slug });

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
        optionalText(input.titleOriginal),
        optionalText(input.language),
        optionalText(input.summary),
        input.visibility,
        input.noindex ? 1 : 0,
        input.visibility,
        id,
      ],
    );

    await execute(
      connection,
      `UPDATE source_detail
          SET csl_type = ?, csl_json = CAST(? AS JSON), container_title = ?, issued_year = ?,
              archive = ?, archive_location = ?, call_number = ?, url = ?,
              accessed_on = ?, notes = ?
        WHERE content_item_id = ?`,
      [
        input.cslType,
        JSON.stringify(csl),
        optionalText(input.containerTitle),
        issuedYear(csl),
        optionalText(input.archive),
        optionalText(input.archiveLocation),
        optionalText(input.callNumber),
        optionalText(input.url),
        accessedDate(input.accessed),
        optionalText(input.note),
        id,
      ],
    );

    return true;
  });
}

/**
 * Publishes or unpublishes a source.
 *
 * `published_at` records the first time the item became public and is not
 * cleared on unpublish, so the audit trail keeps the original date.
 */
export async function setSourceVisibility(
  db: Pool | PoolConnection,
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
      WHERE id = ? AND kind = 'source'`,
    [visibility, visibility, id],
  );
  return result.affectedRows > 0;
}

/**
 * Deletes a source.
 *
 * Returns 'cited' instead of deleting when something still cites it: the
 * foreign key on `citation.source_item_id` is RESTRICT precisely so that
 * removing a source cannot silently break the apparatus of an essay.
 */
export async function deleteSource(
  pool: Pool,
  id: number,
): Promise<'deleted' | 'not_found' | 'cited'> {
  return withTransaction(pool, async (connection) => {
    const citing = await queryOne<RowDataPacket & { total: number }>(
      connection,
      'SELECT COUNT(*) AS total FROM citation WHERE source_item_id = ?',
      [id],
    );
    if ((citing?.total ?? 0) > 0) return 'cited';

    const result = await execute(
      connection,
      `DELETE FROM content_item WHERE id = ? AND kind = 'source'`,
      [id],
    );
    return result.affectedRows > 0 ? 'deleted' : 'not_found';
  });
}

// --- Backlinks -------------------------------------------------------------

export interface CitingItem {
  id: number;
  kind: string;
  slug: string;
  title: string;
  locator: string | null;
}

/**
 * Items that cite this source, restricted to what the viewer may see.
 *
 * A private essay citing a public source must not appear on that source's
 * public page, which is why the filter is applied to the citing item and not
 * only to the source.
 */
export async function listCitingItems(
  db: Pool | PoolConnection,
  sourceId: number,
  viewer: Viewer,
): Promise<CitingItem[]> {
  const visible = visibilityFilter(viewer, 'ci');
  const rows = await queryRows<
    RowDataPacket & {
      id: number;
      kind: string;
      slug: string;
      title: string;
      locator: string | null;
    }
  >(
    db,
    `SELECT ci.id, ci.kind, ci.slug, ci.title, c.locator
       FROM citation c
       JOIN content_item ci ON ci.id = c.citing_item_id
      WHERE c.source_item_id = ? AND ${visible.sql}
      ORDER BY ci.title ASC`,
    [sourceId, ...visible.params],
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    locator: row.locator,
  }));
}
