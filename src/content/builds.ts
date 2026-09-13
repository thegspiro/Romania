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
import { ANONYMOUS, adminViewer, visibilityFilter, type Viewer } from './visibility.js';
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
  /** When an administrator published this build for download; null otherwise. */
  publishedAt: Date | null;
  publishedBy: number | null;
  /** How many content items the document was assembled from. */
  itemCount: number;
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
    publishedAt: (row.published_at as Date | null) ?? null,
    publishedBy: row.published_by === null ? null : Number(row.published_by),
    itemCount: Number(row.item_count ?? 0),
  };
}

const BUILD_COLUMNS =
  'b.id, b.manuscript_item_id, b.format, b.audience, b.state, b.file_object_id, ' +
  'b.section_count, b.word_count, b.log, b.created_at, b.finished_at, ' +
  'p.published_at, p.published_by, ' +
  // Counted rather than joined row by row: the download re-check needs the
  // number, and a build with none recorded is one compiled before this
  // application knew what went into it.
  '(SELECT COUNT(*) FROM manuscript_build_item i WHERE i.build_id = b.id) AS item_count';

/**
 * The build table with its publication, which at most one build per manuscript
 * has. Outer-joined so a build reads the same whether or not it is the one.
 */
const BUILD_FROM =
  'FROM manuscript_build b LEFT JOIN manuscript_published_build p ON p.build_id = b.id';

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

    // What the document was assembled from, recorded in the same transaction
    // as the build row. A published download re-checks every one of these on
    // every request; a build with none recorded can never satisfy that check,
    // which is what keeps a document compiled before the withholding fix out
    // of public reach without a version flag to remember.
    if (document.itemIds.length > 0) {
      const placeholders = document.itemIds.map(() => '(?, ?)').join(', ');
      await execute(
        connection,
        `INSERT INTO manuscript_build_item (build_id, content_item_id) VALUES ${placeholders}`,
        document.itemIds.flatMap((itemId) => [buildId, itemId]),
      );
    }

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
    `SELECT ${BUILD_COLUMNS} ${BUILD_FROM}
      WHERE b.manuscript_item_id = ?
      ORDER BY b.created_at DESC, b.id DESC
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
    `SELECT ${BUILD_COLUMNS} ${BUILD_FROM} WHERE b.id = ?`,
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

// --- Publishing ------------------------------------------------------------

/**
 * Why a build may not be published.
 *
 * Returned rather than thrown so the editor can say which rule stopped it;
 * every one of these is a state the operator can see and fix.
 */
export type PublishRefusal =
  | 'not_succeeded'
  | 'no_output'
  | 'not_public_audience'
  | 'manuscript_not_public'
  | 'no_recorded_items'
  | 'contains_unpublished';

export type PublishOutcome = { ok: true } | { ok: false; reason: PublishRefusal };

/**
 * Publishes one build as the manuscript's public download.
 *
 * Five conditions, checked in one transaction holding the build row, because
 * a compiled file is the one object where a mistake discloses every section at
 * once:
 *
 *   1. it rendered successfully and its bytes are still on record;
 *   2. it was assembled for `public`, meaning with `ANONYMOUS` -- an admin
 *      build contains what an administrator could see and is never publishable
 *      whatever else is true of it;
 *   3. the manuscript itself is published, because a download nobody can find
 *      a page for is still a download;
 *   4. the build records what it was assembled from. A build with no recorded
 *      items predates this application knowing, which in practice means it
 *      predates the fix that withholds private titles from a compiled
 *      document. Recompiling is the way forward, and recompiling is also what
 *      rewrites those references;
 *   5. every recorded item is still published *now*. The document was written
 *      once, so this is the only moment the question can honestly be asked
 *      before the bytes are handed over.
 *
 * Condition 5 is re-checked on every download as well. It is checked here too
 * so publishing a build that is already stale fails loudly at the click rather
 * than silently at the first request.
 */
export async function publishBuild(
  pool: Pool,
  buildId: number,
  publishedBy: number | null,
): Promise<PublishOutcome> {
  return withTransaction(pool, async (connection) => {
    const build = await findBuild(connection, buildId);
    if (build === null) return { ok: false, reason: 'not_succeeded' };
    if (build.state !== 'succeeded') return { ok: false, reason: 'not_succeeded' };
    if (build.fileObjectId === null) return { ok: false, reason: 'no_output' };
    if (build.audience !== 'public') return { ok: false, reason: 'not_public_audience' };
    if (build.itemCount === 0) return { ok: false, reason: 'no_recorded_items' };

    // FOR UPDATE on the manuscript, not because this read needs it but because
    // the write below does: at most one build per manuscript may be published,
    // and two administrators clicking at once would otherwise collide on the
    // primary key rather than queue behind each other. It is the same lock
    // `updateEssay` takes before allocating a revision number.
    const manuscriptVisible = await queryOne<RowDataPacket & { id: number }>(
      connection,
      `SELECT ci.id FROM content_item ci
        WHERE ci.id = ? AND ci.kind = 'manuscript' AND ${visibilityFilter(ANONYMOUS, 'ci').sql}
        FOR UPDATE`,
      [build.manuscriptItemId],
    );
    if (manuscriptVisible === null) return { ok: false, reason: 'manuscript_not_public' };

    const withheld = await countWithheldItems(connection, buildId);
    if (withheld > 0) return { ok: false, reason: 'contains_unpublished' };

    // At most one published build per manuscript, which the table's primary
    // key already guarantees. Withdrawing the previous one is written out
    // rather than left to an upsert, because replacing the download is what
    // publishing a newer build means and the statement should say so.
    await execute(
      connection,
      'DELETE FROM manuscript_published_build WHERE manuscript_item_id = ?',
      [build.manuscriptItemId],
    );
    await execute(
      connection,
      `INSERT INTO manuscript_published_build (manuscript_item_id, build_id, published_by)
       VALUES (?, ?, ?)`,
      [build.manuscriptItemId, buildId, publishedBy],
    );

    return { ok: true };
  });
}

/** Withdraws a published download. Takes effect on the next request. */
export async function withdrawBuild(pool: Pool, buildId: number): Promise<boolean> {
  const result = await execute(pool, 'DELETE FROM manuscript_published_build WHERE build_id = ?', [
    buildId,
  ]);
  return result.affectedRows > 0;
}

/**
 * How many of a build's recorded items are no longer readable by a visitor.
 *
 * Counts what is *missing* rather than what is present, so a deleted item
 * counts as withheld too: the row in `manuscript_build_item` has no foreign
 * key precisely so a deletion leaves the record standing and fails this check
 * rather than quietly shrinking the set that has to pass it.
 */
async function countWithheldItems(db: Pool | PoolConnection, buildId: number): Promise<number> {
  const visible = visibilityFilter(ANONYMOUS, 'ci');
  const row = await queryOne<RowDataPacket & { withheld: number }>(
    db,
    `SELECT COUNT(*) AS withheld
       FROM manuscript_build_item i
       LEFT JOIN content_item ci
         ON ci.id = i.content_item_id AND ${visible.sql}
      WHERE i.build_id = ? AND ci.id IS NULL`,
    [...visible.params, buildId],
  );
  return Number(row?.withheld ?? 0);
}

/**
 * The build to serve for a public download of this manuscript, or null.
 *
 * This is invariant 3 for a file that was written once. Everything it asks is
 * asked now, at request time: the manuscript is still published, a build is
 * still published, its bytes are still on record, and every section that went
 * into it is still readable by a visitor. Any one of them failing means null,
 * and the route turns null into a 404 -- never a 403, because the existence of
 * an unpublished manuscript is itself the disclosure.
 */
export async function findPublicDownload(
  db: Pool | PoolConnection,
  manuscriptSlug: string,
): Promise<BuildRecord | null> {
  const visible = visibilityFilter(ANONYMOUS, 'ci');
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${BUILD_COLUMNS}
       FROM manuscript_build b
       JOIN manuscript_published_build p ON p.build_id = b.id
       JOIN content_item ci ON ci.id = b.manuscript_item_id
      WHERE ci.kind = 'manuscript'
        AND ci.slug = ?
        AND ${visible.sql}
        AND b.audience = 'public'
        AND b.state = 'succeeded'
        AND b.file_object_id IS NOT NULL`,
    [manuscriptSlug, ...visible.params],
  );
  if (row === null) return null;

  const build = toRecord(row);
  // Belt and braces, and not redundant: the query above proves the manuscript
  // and the build are published, this proves the sections inside the file
  // still are. A chapter unpublished after the document was compiled is
  // exactly the case the bytes cannot know about.
  if (build.itemCount === 0) return null;
  if ((await countWithheldItems(db, build.id)) > 0) return null;

  return build;
}
