/**
 * Artifacts: scans, photographs, documents and recordings.
 *
 * An artifact is a catalogue record (`artifact_detail`) that may point at
 * stored bytes (`file_object`). The two are separate on purpose: the record of
 * a document held in an archive is worth keeping whether or not a scan of it
 * has been uploaded, and deleting the bytes must not delete the scholarship.
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
import { rebuildReferences } from './mentions.js';

export interface ArtifactRecord {
  id: number;
  slug: string;
  title: string;
  titleOriginal: string | null;
  language: string | null;
  summary: string | null;
  visibility: Visibility;
  noindex: boolean;
  createdAt: Date;
  updatedAt: Date;
  provenance: string | null;
  repositoryName: string | null;
  physicalLocation: string | null;
  dateCreated: string | null;
  creditLine: string | null;
  rightsStatement: string | null;
  /**
   * The document's own words, typed from the image.
   *
   * Prose, not a plain string: references written here are projected into
   * `mention` by `rebuildReferences`, so a transcription naming someone
   * surfaces on that person's page like any other writing.
   */
  transcription: string | null;
  /** The language of the text, which need not be the record's. */
  transcriptionLanguage: string | null;
  fileObjectId: number | null;
  mimeType: string | null;
  byteSize: number | null;
  originalFilename: string | null;
  /** Derivative variants that exist for the attached file. */
  variants: string[];
  href: string;
}

const COLUMNS = `
  ci.id, ci.slug, ci.title, ci.title_original, ci.language, ci.summary,
  ci.visibility, ci.noindex, ci.created_at, ci.updated_at,
  ad.provenance, ad.repository_name, ad.physical_location, ad.date_created,
  ad.credit_line, ad.rights_statement, ad.transcription, ad.transcription_language,
  ad.file_object_id,
  fo.mime_type, fo.byte_size, fo.original_filename
`;

const FROM = `
  FROM content_item ci
  JOIN artifact_detail ad ON ad.content_item_id = ci.id
  LEFT JOIN file_object fo ON fo.id = ad.file_object_id
`;

function toRecord(row: RowDataPacket, variants: string[] = []): ArtifactRecord {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    title: String(row.title),
    titleOriginal: (row.title_original as string | null) ?? null,
    language: (row.language as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    visibility: row.visibility as Visibility,
    noindex: row.noindex === 1,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    provenance: (row.provenance as string | null) ?? null,
    repositoryName: (row.repository_name as string | null) ?? null,
    physicalLocation: (row.physical_location as string | null) ?? null,
    dateCreated: (row.date_created as string | null) ?? null,
    creditLine: (row.credit_line as string | null) ?? null,
    rightsStatement: (row.rights_statement as string | null) ?? null,
    transcription: (row.transcription as string | null) ?? null,
    transcriptionLanguage: (row.transcription_language as string | null) ?? null,
    fileObjectId: row.file_object_id === null ? null : Number(row.file_object_id),
    mimeType: (row.mime_type as string | null) ?? null,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    originalFilename: (row.original_filename as string | null) ?? null,
    variants,
    href: referenceHref('artifact', String(row.slug)),
  };
}

function text(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function variantsFor(
  db: Pool | PoolConnection,
  fileObjectId: number | null,
): Promise<string[]> {
  if (fileObjectId === null) return [];
  const rows = await queryRows<RowDataPacket & { variant: string }>(
    db,
    'SELECT variant FROM file_derivative WHERE file_object_id = ? ORDER BY variant',
    [fileObjectId],
  );
  return rows.map((row) => row.variant);
}

export async function findArtifactBySlug(
  db: Pool | PoolConnection,
  slug: string,
  viewer: Viewer,
): Promise<ArtifactRecord | null> {
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${COLUMNS} ${FROM} WHERE ci.kind = 'artifact' AND ci.slug = ? AND ${visible.sql}`,
    [slug, ...visible.params],
  );
  if (row === null) return null;
  return toRecord(
    row,
    await variantsFor(db, row.file_object_id === null ? null : Number(row.file_object_id)),
  );
}

export async function findArtifactById(
  db: Pool | PoolConnection,
  id: number,
  viewer: Viewer,
): Promise<ArtifactRecord | null> {
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${COLUMNS} ${FROM} WHERE ci.kind = 'artifact' AND ci.id = ? AND ${visible.sql}`,
    [id, ...visible.params],
  );
  if (row === null) return null;
  return toRecord(
    row,
    await variantsFor(db, row.file_object_id === null ? null : Number(row.file_object_id)),
  );
}

export async function listArtifacts(
  db: Pool | PoolConnection,
  viewer: Viewer,
  options: {
    search?: string | undefined;
    visibility?: Visibility | undefined;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: ArtifactRecord[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const visible = visibilityFilter(viewer, 'ci');
  const conditions = [`ci.kind = 'artifact'`, visible.sql];
  const params: SqlParam[] = [...visible.params];

  const search = options.search?.trim();
  if (search !== undefined && search !== '') {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      `(ci.title LIKE ? ESCAPE '\\\\' OR ci.summary LIKE ? ESCAPE '\\\\'
        OR ad.repository_name LIKE ? ESCAPE '\\\\' OR ad.physical_location LIKE ? ESCAPE '\\\\'
        OR ad.transcription LIKE ? ESCAPE '\\\\')`,
    );
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  if (options.visibility !== undefined && viewer.kind === 'admin') {
    conditions.push('ci.visibility = ?');
    params.push(options.visibility);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const totalRow = await queryOne<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(*) AS total ${FROM} ${where}`,
    params,
  );
  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT ${COLUMNS} ${FROM} ${where} ORDER BY ci.title ASC, ci.id ASC ${limitOffsetClause(limit, offset)}`,
    params,
  );

  return { items: rows.map((row) => toRecord(row)), total: Number(totalRow?.total ?? 0) };
}

export interface ArtifactInput {
  title: string;
  titleOriginal: string;
  language: string;
  summary: string;
  visibility: Visibility;
  noindex: boolean;
  provenance: string;
  repositoryName: string;
  physicalLocation: string;
  dateCreated: string;
  creditLine: string;
  rightsStatement: string;
  /**
   * Optional so that adding them did not change the shape every existing
   * caller already builds. The admin form always posts both; a caller that
   * omits them is saying "no transcription", which is what an artifact
   * created before this column had.
   */
  transcription?: string;
  transcriptionLanguage?: string;
}

function detailParams(input: ArtifactInput): (string | null)[] {
  return [
    text(input.provenance),
    text(input.repositoryName),
    text(input.physicalLocation),
    text(input.dateCreated),
    text(input.creditLine),
    text(input.rightsStatement),
    text(input.transcription ?? ''),
    text(input.transcriptionLanguage ?? ''),
  ];
}

export async function createArtifact(pool: Pool, input: ArtifactInput): Promise<number> {
  return withTransaction(pool, async (connection) => {
    const slug = await uniqueSlug(
      slugify(input.title),
      async (candidate) => {
        const row = await queryOne<RowDataPacket & { id: number }>(
          connection,
          `SELECT id FROM content_item WHERE kind = 'artifact' AND slug = ?`,
          [candidate],
        );
        return row !== null;
      },
      'artifact',
    );

    const result = await execute(
      connection,
      `INSERT INTO content_item
         (kind, slug, title, title_original, language, summary, visibility, noindex, published_at)
       VALUES ('artifact', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      `INSERT INTO artifact_detail
         (content_item_id, provenance, repository_name, physical_location, date_created,
          credit_line, rights_statement, transcription, transcription_language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ...detailParams(input)],
    );

    // Same transaction as the text: the projection cannot describe a version
    // of the transcription that was never committed. The artifact's one prose
    // column, as an essay's body is its.
    await rebuildReferences(connection, id, input.transcription ?? '');
    return id;
  });
}

export async function updateArtifact(
  pool: Pool,
  id: number,
  input: ArtifactInput,
): Promise<boolean> {
  return withTransaction(pool, async (connection) => {
    const existing = await queryOne<RowDataPacket & { id: number }>(
      connection,
      `SELECT id FROM content_item WHERE id = ? AND kind = 'artifact' FOR UPDATE`,
      [id],
    );
    if (existing === null) return false;

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
      `UPDATE artifact_detail
          SET provenance = ?, repository_name = ?, physical_location = ?, date_created = ?,
              credit_line = ?, rights_statement = ?,
              transcription = ?, transcription_language = ?
        WHERE content_item_id = ?`,
      [...detailParams(input), id],
    );

    await rebuildReferences(connection, id, input.transcription ?? '');
    return true;
  });
}

export async function setArtifactVisibility(
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
      WHERE id = ? AND kind = 'artifact'`,
    [visibility, visibility, id],
  );
  return result.affectedRows > 0;
}

/** Attaches stored bytes to an artifact, replacing whatever was there. */
export async function attachFile(
  db: Pool | PoolConnection,
  artifactId: number,
  fileObjectId: number,
): Promise<boolean> {
  const result = await execute(
    db,
    'UPDATE artifact_detail SET file_object_id = ? WHERE content_item_id = ?',
    [fileObjectId, artifactId],
  );
  return result.affectedRows > 0;
}

export async function deleteArtifact(
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
      `DELETE FROM content_item WHERE id = ? AND kind = 'artifact'`,
      [id],
    );
    return result.affectedRows > 0 ? 'deleted' : 'not_found';
  });
}
