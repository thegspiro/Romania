/**
 * Compiling a manuscript into a single document.
 *
 * The division of labour is deliberate: **TypeScript assembles, Python
 * renders.** The web application walks the outline, applies the visibility
 * filter, demotes headings and rewrites references, then writes a plain
 * Markdown file and a CSL-JSON bibliography. The worker's only job is to run
 * Pandoc over those two files.
 *
 * That keeps the visibility decision in the one place CLAUDE.md requires it,
 * and avoids a second cross-language duplication of reference parsing.
 *
 * `audience` is the safety mechanism. A compiled file is a single object
 * containing many sections, so it is the one place a mistake would disclose
 * everything at once. The column records which viewer the document was
 * assembled for, and the download route refuses anything it does not match.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import {
  execute,
  limitOffsetClause,
  queryOne,
  queryRows,
  withTransaction,
  type Pool,
  type PoolConnection,
} from '../db/pool.js';
import type { Config } from '../config.js';
import { ANONYMOUS, adminViewer, type Viewer } from './visibility.js';
import { assembleDocument, type ManuscriptRecord } from './manuscripts.js';
import { resolveStoragePath } from '../files/storage.js';

export const BUILD_FORMATS = ['pdf', 'docx', 'html', 'latex', 'markdown'] as const;
export type BuildFormat = (typeof BUILD_FORMATS)[number];

export function isBuildFormat(value: unknown): value is BuildFormat {
  return typeof value === 'string' && (BUILD_FORMATS as readonly string[]).includes(value);
}

export type BuildAudience = 'admin' | 'public';

export function isBuildAudience(value: unknown): value is BuildAudience {
  return value === 'admin' || value === 'public';
}

export interface BuildRecord {
  id: number;
  manuscriptItemId: number;
  format: BuildFormat;
  audience: BuildAudience;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  fileObjectId: number | null;
  sectionCount: number;
  wordCount: number;
  log: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

function toRecord(row: RowDataPacket): BuildRecord {
  return {
    id: Number(row.id),
    manuscriptItemId: Number(row.manuscript_item_id),
    format: row.format as BuildFormat,
    audience: row.audience as BuildAudience,
    state: row.state as BuildRecord['state'],
    fileObjectId: row.file_object_id === null ? null : Number(row.file_object_id),
    sectionCount: Number(row.section_count ?? 0),
    wordCount: Number(row.word_count ?? 0),
    log: (row.log as string | null) ?? null,
    createdAt: row.created_at as Date,
    finishedAt: (row.finished_at as Date | null) ?? null,
  };
}

const BUILD_COLUMNS =
  'id, manuscript_item_id, format, audience, state, file_object_id, section_count, ' +
  'word_count, log, created_at, finished_at';

/** Staging directory for one build, relative to STORAGE_ROOT. */
export function stagingKey(buildId: number, filename: string): string {
  if (!Number.isSafeInteger(buildId) || buildId <= 0) {
    throw new TypeError(`Invalid build id: ${String(buildId)}`);
  }
  return `builds/${buildId}/${filename}`;
}

export interface RequestBuildResult {
  buildId: number;
  sectionCount: number;
  wordCount: number;
  withheldCitations: string[];
}

/**
 * Assembles a manuscript and queues it for rendering.
 *
 * The document is assembled for `audience` -- a public build uses an anonymous
 * viewer, so it can only contain sections that viewer could already read one
 * page at a time.
 *
 * Staging files are written before the job row is committed, so the worker
 * cannot observe a job whose input does not yet exist.
 */
export async function requestBuild(
  pool: Pool,
  config: Config,
  manuscript: ManuscriptRecord,
  options: { format: BuildFormat; audience: BuildAudience; requestedBy: number | null },
): Promise<RequestBuildResult> {
  const viewer: Viewer =
    options.audience === 'public' ? ANONYMOUS : adminViewer(options.requestedBy ?? 0);

  const document = await assembleDocument(pool, manuscript, viewer);

  return withTransaction(pool, async (connection) => {
    const inserted = await execute(
      connection,
      `INSERT INTO manuscript_build
         (manuscript_item_id, format, audience, state, section_count, word_count, requested_by)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [
        manuscript.id,
        options.format,
        options.audience,
        document.sectionCount,
        document.wordCount,
        options.requestedBy,
      ],
    );
    const buildId = inserted.insertId;

    const documentPath = resolveStoragePath(
      config.STORAGE_ROOT,
      stagingKey(buildId, 'document.md'),
    );
    await mkdir(dirname(documentPath), { recursive: true });

    // Pandoc reads the title-page fields from a YAML metadata block.
    const frontMatter = buildMetadataBlock(manuscript);
    await writeFile(documentPath, `${frontMatter}\n\n${document.markdown}\n`, 'utf8');

    await writeFile(
      resolveStoragePath(config.STORAGE_ROOT, stagingKey(buildId, 'references.json')),
      JSON.stringify(document.bibliography, null, 2),
      'utf8',
    );

    await execute(
      connection,
      `INSERT INTO job (kind, payload) VALUES ('manuscript.compile', CAST(? AS JSON))`,
      [JSON.stringify({ buildId })],
    );

    return {
      buildId,
      sectionCount: document.sectionCount,
      wordCount: document.wordCount,
      withheldCitations: document.withheldCitations,
    };
  });
}

/**
 * Pandoc's YAML metadata block.
 *
 * Values are JSON-encoded, which is valid YAML for scalars and removes any
 * question of a colon or quote in a title terminating the block early.
 */
function buildMetadataBlock(manuscript: ManuscriptRecord): string {
  const fields: [string, string | boolean | null][] = [
    ['title', manuscript.title],
    ['subtitle', manuscript.subtitle],
    ['author', manuscript.authorName],
    ['date', manuscript.submittedOn],
    ['institute', manuscript.institution],
    ['abstract', manuscript.abstractMarkdown],
    ['numbersections', manuscript.numberSections],
    ['link-citations', true],
    ['lang', 'en'],
  ];

  const lines = fields
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);

  return ['---', ...lines, '---'].join('\n');
}

export async function listBuilds(
  db: Pool | PoolConnection,
  manuscriptId: number,
  limit = 20,
): Promise<BuildRecord[]> {
  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT ${BUILD_COLUMNS} FROM manuscript_build
      WHERE manuscript_item_id = ?
      ORDER BY created_at DESC, id DESC
      ${limitOffsetClause(Math.min(Math.max(Math.trunc(limit), 1), 100))}`,
    [manuscriptId],
  );
  return rows.map(toRecord);
}

export async function findBuild(
  db: Pool | PoolConnection,
  buildId: number,
): Promise<BuildRecord | null> {
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${BUILD_COLUMNS} FROM manuscript_build WHERE id = ?`,
    [buildId],
  );
  return row === null ? null : toRecord(row);
}

/** File extension and content type for each output format. */
export const BUILD_MEDIA: Readonly<Record<BuildFormat, { extension: string; mimeType: string }>> =
  Object.freeze({
    pdf: { extension: 'pdf', mimeType: 'application/pdf' },
    docx: {
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    html: { extension: 'html', mimeType: 'text/html' },
    latex: { extension: 'tex', mimeType: 'application/x-tex' },
    markdown: { extension: 'md', mimeType: 'text/markdown' },
  });
