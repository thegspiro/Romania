/**
 * Essays: the prose that becomes the dissertation.
 *
 * An essay is publishable on its own page and may also be placed in a
 * manuscript, where it becomes a chapter or section. It is written once and
 * serves both.
 *
 * Every write rebuilds the mention and citation projections inside the same
 * transaction as the body change, so those tables can never describe an older
 * version of the text than the one on disk.
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
import { countWords } from './markdown.js';
import { rebuildReferences, type RebuildResult } from './mentions.js';
import { referenceHref } from './references.js';

export const ESSAY_STATUSES = ['draft', 'in_review', 'final'] as const;
export type EssayStatus = (typeof ESSAY_STATUSES)[number];

export function isEssayStatus(value: unknown): value is EssayStatus {
  return typeof value === 'string' && (ESSAY_STATUSES as readonly string[]).includes(value);
}

export interface EssayRecord {
  id: number;
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
  bodyMarkdown: string;
  status: EssayStatus;
  wordCount: number;
  href: string;
}

const COLUMNS = `
  ci.id, ci.slug, ci.title, ci.title_original, ci.language, ci.summary,
  ci.visibility, ci.noindex, ci.published_at, ci.created_at, ci.updated_at,
  ed.body_markdown, ed.status, ed.word_count
`;

const FROM = `
  FROM content_item ci
  JOIN essay_detail ed ON ed.content_item_id = ci.id
`;

function toRecord(row: RowDataPacket): EssayRecord {
  return {
    id: Number(row.id),
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
    bodyMarkdown: String(row.body_markdown ?? ''),
    status: row.status as EssayStatus,
    wordCount: Number(row.word_count ?? 0),
    href: referenceHref('essay', String(row.slug)),
  };
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function text(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export async function findEssayBySlug(
  db: Pool | PoolConnection,
  slug: string,
  viewer: Viewer,
): Promise<EssayRecord | null> {
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${COLUMNS} ${FROM} WHERE ci.kind = 'essay' AND ci.slug = ? AND ${visible.sql}`,
    [slug, ...visible.params],
  );
  return row === null ? null : toRecord(row);
}

export async function findEssayById(
  db: Pool | PoolConnection,
  id: number,
  viewer: Viewer,
): Promise<EssayRecord | null> {
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${COLUMNS} ${FROM} WHERE ci.kind = 'essay' AND ci.id = ? AND ${visible.sql}`,
    [id, ...visible.params],
  );
  return row === null ? null : toRecord(row);
}

export interface ListEssaysOptions {
  search?: string | undefined;
  visibility?: Visibility | undefined;
  status?: EssayStatus | undefined;
  limit?: number;
  offset?: number;
}

export async function listEssays(
  db: Pool | PoolConnection,
  viewer: Viewer,
  options: ListEssaysOptions = {},
): Promise<{ items: EssayRecord[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const visible = visibilityFilter(viewer, 'ci');
  const conditions = [`ci.kind = 'essay'`, visible.sql];
  const params: SqlParam[] = [...visible.params];

  const search = options.search?.trim();
  if (search !== undefined && search !== '') {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      `(ci.title LIKE ? ESCAPE '\\\\' OR ci.summary LIKE ? ESCAPE '\\\\' OR ed.body_markdown LIKE ? ESCAPE '\\\\')`,
    );
    params.push(pattern, pattern, pattern);
  }

  if (options.visibility !== undefined && viewer.kind === 'admin') {
    conditions.push('ci.visibility = ?');
    params.push(options.visibility);
  }
  if (options.status !== undefined) {
    conditions.push('ed.status = ?');
    params.push(options.status);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const totalRow = await queryOne<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(*) AS total ${FROM} ${where}`,
    params,
  );
  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT ${COLUMNS} ${FROM} ${where}
      ORDER BY ci.title ASC, ci.id ASC
      ${limitOffsetClause(limit, offset)}`,
    params,
  );

  return { items: rows.map(toRecord), total: Number(totalRow?.total ?? 0) };
}

export interface EssayInput {
  title: string;
  titleOriginal: string;
  language: string;
  summary: string;
  visibility: Visibility;
  noindex: boolean;
  bodyMarkdown: string;
  status: EssayStatus;
}

export interface EssayWriteResult {
  id: number;
  references: RebuildResult;
}

export async function createEssay(pool: Pool, input: EssayInput): Promise<EssayWriteResult> {
  return withTransaction(pool, async (connection) => {
    const slug = await uniqueSlug(
      slugify(input.title),
      async (candidate) => {
        const row = await queryOne<RowDataPacket & { id: number }>(
          connection,
          `SELECT id FROM content_item WHERE kind = 'essay' AND slug = ?`,
          [candidate],
        );
        return row !== null;
      },
      'essay',
    );

    const result = await execute(
      connection,
      `INSERT INTO content_item
         (kind, slug, title, title_original, language, summary, visibility, noindex, published_at)
       VALUES ('essay', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
    await execute(
      connection,
      `INSERT INTO essay_detail (content_item_id, body_markdown, status, word_count)
       VALUES (?, ?, ?, ?)`,
      [id, input.bodyMarkdown, input.status, countWords(input.bodyMarkdown)],
    );

    // Same transaction as the body: the projections cannot describe an older
    // version of the text than the one just stored.
    const references = await rebuildReferences(connection, id, input.bodyMarkdown);
    return { id, references };
  });
}

export async function updateEssay(
  pool: Pool,
  id: number,
  input: EssayInput,
): Promise<EssayWriteResult | null> {
  return withTransaction(pool, async (connection) => {
    const existing = await queryOne<RowDataPacket & { id: number }>(
      connection,
      `SELECT id FROM content_item WHERE id = ? AND kind = 'essay' FOR UPDATE`,
      [id],
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

    await execute(
      connection,
      `UPDATE essay_detail SET body_markdown = ?, status = ?, word_count = ?
        WHERE content_item_id = ?`,
      [input.bodyMarkdown, input.status, countWords(input.bodyMarkdown), id],
    );

    const references = await rebuildReferences(connection, id, input.bodyMarkdown);
    return { id, references };
  });
}

export async function setEssayVisibility(
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
      WHERE id = ? AND kind = 'essay'`,
    [visibility, visibility, id],
  );
  return result.affectedRows > 0;
}

/**
 * Deletes an essay.
 *
 * Its own mentions and citations vanish with it (they are CASCADE on the
 * citing side); what blocks deletion is other prose referring to *this* essay.
 */
export async function deleteEssay(
  pool: Pool,
  id: number,
): Promise<'deleted' | 'not_found' | 'referenced'> {
  return withTransaction(pool, async (connection) => {
    const referenced = await queryOne<RowDataPacket & { total: number }>(
      connection,
      'SELECT COUNT(*) AS total FROM mention WHERE to_item_id = ?',
      [id],
    );
    if (Number(referenced?.total ?? 0) > 0) return 'referenced';

    const result = await execute(
      connection,
      `DELETE FROM content_item WHERE id = ? AND kind = 'essay'`,
      [id],
    );
    return result.affectedRows > 0 ? 'deleted' : 'not_found';
  });
}
