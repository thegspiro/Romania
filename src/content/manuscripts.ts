/**
 * Manuscripts: the structure that knows how the pieces fit together.
 *
 * Each essay is a page in its own right. A manuscript records where those
 * pieces sit in a single document, so the same prose serves both without being
 * written twice.
 *
 * The outline is an ordered list with a depth column rather than a
 * parent/child tree -- see the comment on `manuscript_section` in migration
 * 0005 for why. Everything here is therefore a linear walk.
 *
 * `assembleDocument` is where the visibility rule and compilation meet: it
 * takes a `Viewer` like every other read path, so the document produced for
 * the public can only ever contain what the public may already read.
 */
import type { RowDataPacket } from 'mysql2/promise';
import {
  execute,
  queryOne,
  queryRows,
  withTransaction,
  type Pool,
  type PoolConnection,
} from '../db/pool.js';
import { slugify, uniqueSlug } from './slug.js';
import { visibilityFilter, type Viewer, type Visibility } from './visibility.js';
import { parseStoredCslItem, type CslItem } from '../citations/csl.js';
import { parseReferences, referenceHref, targetKind } from './references.js';
import { resolveTargets } from './mentions.js';
import { countWords } from './markdown.js';

export const SECTION_ROLES = ['front_matter', 'body', 'appendix', 'back_matter'] as const;
export type SectionRole = (typeof SECTION_ROLES)[number];

export function isSectionRole(value: unknown): value is SectionRole {
  return typeof value === 'string' && (SECTION_ROLES as readonly string[]).includes(value);
}

export const MAX_SECTION_DEPTH = 5;

export interface ManuscriptRecord {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  summary: string | null;
  visibility: Visibility;
  noindex: boolean;
  authorName: string | null;
  degree: string | null;
  institution: string | null;
  submittedOn: string | null;
  abstractMarkdown: string | null;
  acknowledgementsMarkdown: string | null;
  numberSections: boolean;
  createdAt: Date;
  updatedAt: Date;
  href: string;
}

export interface SectionRecord {
  id: number;
  itemId: number;
  kind: string;
  slug: string;
  /** The title as it reads in this manuscript, honouring an override. */
  title: string;
  ownTitle: string;
  position: number;
  depth: number;
  role: SectionRole;
  visibility: Visibility;
  wordCount: number;
  href: string;
}

const MANUSCRIPT_COLUMNS = `
  ci.id, ci.slug, ci.title, ci.summary, ci.visibility, ci.noindex,
  ci.created_at, ci.updated_at,
  md.subtitle, md.author_name, md.degree, md.institution, md.submitted_on,
  md.abstract_markdown, md.acknowledgements_markdown, md.number_sections
`;

const MANUSCRIPT_FROM = `
  FROM content_item ci
  JOIN manuscript_detail md ON md.content_item_id = ci.id
`;

function toManuscript(row: RowDataPacket): ManuscriptRecord {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    title: String(row.title),
    subtitle: (row.subtitle as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    visibility: row.visibility as Visibility,
    noindex: row.noindex === 1,
    authorName: (row.author_name as string | null) ?? null,
    degree: (row.degree as string | null) ?? null,
    institution: (row.institution as string | null) ?? null,
    submittedOn: row.submitted_on === null ? null : String(row.submitted_on).slice(0, 10),
    abstractMarkdown: (row.abstract_markdown as string | null) ?? null,
    acknowledgementsMarkdown: (row.acknowledgements_markdown as string | null) ?? null,
    numberSections: row.number_sections === 1,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    href: referenceHref('manuscript', String(row.slug)),
  };
}

function text(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// --- Reads -----------------------------------------------------------------

export async function findManuscriptBySlug(
  db: Pool | PoolConnection,
  slug: string,
  viewer: Viewer,
): Promise<ManuscriptRecord | null> {
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${MANUSCRIPT_COLUMNS} ${MANUSCRIPT_FROM}
      WHERE ci.kind = 'manuscript' AND ci.slug = ? AND ${visible.sql}`,
    [slug, ...visible.params],
  );
  return row === null ? null : toManuscript(row);
}

export async function findManuscriptById(
  db: Pool | PoolConnection,
  id: number,
  viewer: Viewer,
): Promise<ManuscriptRecord | null> {
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${MANUSCRIPT_COLUMNS} ${MANUSCRIPT_FROM}
      WHERE ci.kind = 'manuscript' AND ci.id = ? AND ${visible.sql}`,
    [id, ...visible.params],
  );
  return row === null ? null : toManuscript(row);
}

export async function listManuscripts(
  db: Pool | PoolConnection,
  viewer: Viewer,
): Promise<ManuscriptRecord[]> {
  const visible = visibilityFilter(viewer, 'ci');
  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT ${MANUSCRIPT_COLUMNS} ${MANUSCRIPT_FROM}
      WHERE ci.kind = 'manuscript' AND ${visible.sql}
      ORDER BY ci.title ASC`,
    visible.params,
  );
  return rows.map(toManuscript);
}

/**
 * The outline, in reading order, filtered to what the viewer may see.
 *
 * A private section is omitted entirely -- no placeholder, no gap in the
 * numbering. A "section 4 withheld" marker would disclose that it exists,
 * which is precisely what invariant 2 forbids.
 */
export async function listSections(
  db: Pool | PoolConnection,
  manuscriptId: number,
  viewer: Viewer,
): Promise<SectionRecord[]> {
  const visible = visibilityFilter(viewer, 'ci');
  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT ms.id, ms.content_item_id, ms.position, ms.depth, ms.role, ms.title_override,
            ci.kind, ci.slug, ci.title, ci.visibility,
            COALESCE(ed.word_count, 0) AS word_count
       FROM manuscript_section ms
       JOIN content_item ci ON ci.id = ms.content_item_id
       LEFT JOIN essay_detail ed ON ed.content_item_id = ci.id
      WHERE ms.manuscript_item_id = ? AND ${visible.sql}
      ORDER BY ms.position ASC, ms.id ASC`,
    [manuscriptId, ...visible.params],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    itemId: Number(row.content_item_id),
    kind: String(row.kind),
    slug: String(row.slug),
    title: String(row.title_override ?? row.title),
    ownTitle: String(row.title),
    position: Number(row.position),
    depth: Number(row.depth),
    role: row.role as SectionRole,
    visibility: row.visibility as Visibility,
    wordCount: Number(row.word_count ?? 0),
    href: referenceHref(String(row.kind), String(row.slug)),
  }));
}

/** Manuscripts an item appears in, so a page can show where it belongs. */
export async function listPlacementsOf(
  db: Pool | PoolConnection,
  itemId: number,
  viewer: Viewer,
): Promise<{ manuscript: ManuscriptRecord; sectionId: number; position: number }[]> {
  const visible = visibilityFilter(viewer, 'ci');
  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT ${MANUSCRIPT_COLUMNS}, ms.id AS section_id, ms.position
       FROM manuscript_section ms
       JOIN content_item ci ON ci.id = ms.manuscript_item_id
       JOIN manuscript_detail md ON md.content_item_id = ci.id
      WHERE ms.content_item_id = ? AND ${visible.sql}
      ORDER BY ci.title ASC`,
    [itemId, ...visible.params],
  );

  return rows.map((row) => ({
    manuscript: toManuscript(row),
    sectionId: Number(row.section_id),
    position: Number(row.position),
  }));
}

export interface SectionNavigation {
  manuscript: ManuscriptRecord;
  index: number;
  total: number;
  previous: SectionRecord | null;
  next: SectionRecord | null;
  current: SectionRecord;
}

/**
 * Where a piece sits in the whole: "Chapter 3 of 8", with prev and next.
 *
 * Computed over the viewer-filtered outline, so a reader never learns that
 * something was skipped between two sections they can see.
 */
export async function navigationFor(
  db: Pool | PoolConnection,
  manuscriptId: number,
  itemId: number,
  viewer: Viewer,
): Promise<SectionNavigation | null> {
  const manuscript = await findManuscriptById(db, manuscriptId, viewer);
  if (manuscript === null) return null;

  const sections = await listSections(db, manuscriptId, viewer);
  const index = sections.findIndex((section) => section.itemId === itemId);
  if (index === -1) return null;

  return {
    manuscript,
    index,
    total: sections.length,
    previous: sections[index - 1] ?? null,
    next: sections[index + 1] ?? null,
    current: sections[index]!,
  };
}

// --- Writes ----------------------------------------------------------------

export interface ManuscriptInput {
  title: string;
  subtitle: string;
  summary: string;
  visibility: Visibility;
  noindex: boolean;
  authorName: string;
  degree: string;
  institution: string;
  submittedOn: string;
  abstractMarkdown: string;
  acknowledgementsMarkdown: string;
  numberSections: boolean;
}

function detailParams(input: ManuscriptInput): (string | number | null)[] {
  return [
    text(input.subtitle),
    text(input.authorName),
    text(input.degree),
    text(input.institution),
    /^\d{4}-\d{2}-\d{2}$/.test(input.submittedOn.trim()) ? input.submittedOn.trim() : null,
    text(input.abstractMarkdown),
    text(input.acknowledgementsMarkdown),
    input.numberSections ? 1 : 0,
  ];
}

export async function createManuscript(pool: Pool, input: ManuscriptInput): Promise<number> {
  return withTransaction(pool, async (connection) => {
    const slug = await uniqueSlug(
      slugify(input.title),
      async (candidate) => {
        const row = await queryOne<RowDataPacket & { id: number }>(
          connection,
          `SELECT id FROM content_item WHERE kind = 'manuscript' AND slug = ?`,
          [candidate],
        );
        return row !== null;
      },
      'manuscript',
    );

    const result = await execute(
      connection,
      `INSERT INTO content_item (kind, slug, title, summary, visibility, noindex, published_at)
       VALUES ('manuscript', ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        input.title.trim(),
        text(input.summary),
        input.visibility,
        input.noindex ? 1 : 0,
        input.visibility === 'public' ? new Date() : null,
      ],
    );

    const id = result.insertId;
    await execute(
      connection,
      `INSERT INTO manuscript_detail
         (content_item_id, subtitle, author_name, degree, institution, submitted_on,
          abstract_markdown, acknowledgements_markdown, number_sections)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ...detailParams(input)],
    );
    return id;
  });
}

export async function updateManuscript(
  pool: Pool,
  id: number,
  input: ManuscriptInput,
): Promise<boolean> {
  return withTransaction(pool, async (connection) => {
    const existing = await queryOne<RowDataPacket & { id: number }>(
      connection,
      `SELECT id FROM content_item WHERE id = ? AND kind = 'manuscript' FOR UPDATE`,
      [id],
    );
    if (existing === null) return false;

    await execute(
      connection,
      `UPDATE content_item
          SET title = ?, summary = ?, visibility = ?, noindex = ?,
              published_at = CASE
                WHEN ? = 'public' AND published_at IS NULL THEN NOW(3)
                ELSE published_at
              END
        WHERE id = ?`,
      [
        input.title.trim(),
        text(input.summary),
        input.visibility,
        input.noindex ? 1 : 0,
        input.visibility,
        id,
      ],
    );

    await execute(
      connection,
      `UPDATE manuscript_detail
          SET subtitle = ?, author_name = ?, degree = ?, institution = ?, submitted_on = ?,
              abstract_markdown = ?, acknowledgements_markdown = ?, number_sections = ?
        WHERE content_item_id = ?`,
      [...detailParams(input), id],
    );
    return true;
  });
}

export async function deleteManuscript(pool: Pool, id: number): Promise<boolean> {
  // Sections and builds cascade; the essays themselves are untouched, which
  // is the point of a manuscript being an arrangement rather than a container.
  const result = await execute(
    pool,
    `DELETE FROM content_item WHERE id = ? AND kind = 'manuscript'`,
    [id],
  );
  return result.affectedRows > 0;
}

// --- Outline editing -------------------------------------------------------

export type AddSectionOutcome =
  | { ok: true; sectionId: number }
  | { ok: false; reason: 'already_present' | 'unknown_item' | 'self' };

export async function addSection(
  pool: Pool,
  manuscriptId: number,
  itemId: number,
  options: { depth?: number; role?: SectionRole } = {},
): Promise<AddSectionOutcome> {
  if (manuscriptId === itemId) return { ok: false, reason: 'self' };

  return withTransaction(pool, async (connection) => {
    const item = await queryOne<RowDataPacket & { id: number }>(
      connection,
      `SELECT id FROM content_item WHERE id = ? AND kind <> 'manuscript'`,
      [itemId],
    );
    if (item === null) return { ok: false, reason: 'unknown_item' };

    const existing = await queryOne<RowDataPacket & { id: number }>(
      connection,
      'SELECT id FROM manuscript_section WHERE manuscript_item_id = ? AND content_item_id = ?',
      [manuscriptId, itemId],
    );
    if (existing !== null) return { ok: false, reason: 'already_present' };

    const last = await queryOne<RowDataPacket & { position: number | null }>(
      connection,
      'SELECT MAX(position) AS position FROM manuscript_section WHERE manuscript_item_id = ?',
      [manuscriptId],
    );

    const result = await execute(
      connection,
      `INSERT INTO manuscript_section
         (manuscript_item_id, content_item_id, position, depth, role)
       VALUES (?, ?, ?, ?, ?)`,
      [
        manuscriptId,
        itemId,
        Number(last?.position ?? -1) + 1,
        Math.min(Math.max(options.depth ?? 0, 0), MAX_SECTION_DEPTH),
        options.role ?? 'body',
      ],
    );
    return { ok: true, sectionId: result.insertId };
  });
}

export async function removeSection(
  db: Pool | PoolConnection,
  manuscriptId: number,
  sectionId: number,
): Promise<boolean> {
  const result = await execute(
    db,
    'DELETE FROM manuscript_section WHERE id = ? AND manuscript_item_id = ?',
    [sectionId, manuscriptId],
  );
  return result.affectedRows > 0;
}

export async function updateSection(
  db: Pool | PoolConnection,
  manuscriptId: number,
  sectionId: number,
  changes: { depth?: number; role?: SectionRole; titleOverride?: string },
): Promise<boolean> {
  const current = await queryOne<RowDataPacket & { depth: number; role: SectionRole }>(
    db,
    'SELECT depth, role FROM manuscript_section WHERE id = ? AND manuscript_item_id = ?',
    [sectionId, manuscriptId],
  );
  if (current === null) return false;

  const result = await execute(
    db,
    `UPDATE manuscript_section SET depth = ?, role = ?, title_override = ?
      WHERE id = ? AND manuscript_item_id = ?`,
    [
      Math.min(Math.max(changes.depth ?? Number(current.depth), 0), MAX_SECTION_DEPTH),
      changes.role ?? current.role,
      changes.titleOverride === undefined ? null : text(changes.titleOverride),
      sectionId,
      manuscriptId,
    ],
  );
  return result.affectedRows > 0;
}

/**
 * Moves a section one place earlier or later in reading order.
 *
 * Positions are rewritten densely afterwards, so repeated moves cannot drift
 * into sparse or colliding values.
 */
export async function moveSection(
  pool: Pool,
  manuscriptId: number,
  sectionId: number,
  direction: 'up' | 'down',
): Promise<boolean> {
  return withTransaction(pool, async (connection) => {
    const rows = await queryRows<RowDataPacket & { id: number }>(
      connection,
      `SELECT id FROM manuscript_section
        WHERE manuscript_item_id = ?
        ORDER BY position ASC, id ASC
        FOR UPDATE`,
      [manuscriptId],
    );

    const order = rows.map((row) => Number(row.id));
    const index = order.indexOf(sectionId);
    if (index === -1) return false;

    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= order.length) return false;

    [order[index], order[target]] = [order[target]!, order[index]!];

    for (const [position, id] of order.entries()) {
      await execute(connection, 'UPDATE manuscript_section SET position = ? WHERE id = ?', [
        position,
        id,
      ]);
    }
    return true;
  });
}

// --- Assembly --------------------------------------------------------------

export interface AssembledDocument {
  markdown: string;
  bibliography: CslItem[];
  sectionCount: number;
  wordCount: number;
  /** Cited sources the audience cannot see; a warning, not an error. */
  withheldCitations: string[];
}

/**
 * Demotes Markdown headings by `levels`, leaving fenced code untouched.
 *
 * A `#` inside a code fence is a comment in someone's shell example, not a
 * heading, and demoting it would corrupt the sample.
 */
export function demoteHeadings(markdown: string, levels: number): string {
  if (levels <= 0) return markdown;

  let inFence = false;
  let fenceMarker = '';

  return markdown
    .split('\n')
    .map((line) => {
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        const marker = fence[1]!;
        if (!inFence) {
          inFence = true;
          fenceMarker = marker[0]!;
        } else if (marker[0] === fenceMarker) {
          inFence = false;
        }
        return line;
      }
      if (inFence) return line;

      const heading = /^(#{1,6})(\s)/.exec(line);
      if (heading === null) return line;

      // Markdown has no heading beyond level 6; clamp rather than emit `#######`,
      // which Pandoc would render as literal text.
      const depth = Math.min(heading[1]!.length + levels, 6);
      return `${'#'.repeat(depth)}${line.slice(heading[1]!.length)}`;
    })
    .join('\n');
}

/**
 * Rewrites inline references for Pandoc.
 *
 * Citations become Pandoc citation syntax so `--citeproc` renders Chicago
 * footnotes and the bibliography. Mentions become plain text, except where the
 * target is itself a section of this manuscript, which becomes an internal
 * cross-reference.
 */
export function referencesToPandoc(
  markdown: string,
  sectionAnchors: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
): string {
  const references = parseReferences(markdown);
  if (references.length === 0) return markdown;

  let result = '';
  let cursor = 0;

  for (const reference of references) {
    result += markdown.slice(cursor, reference.index);
    cursor = reference.index + reference.raw.length;

    if (reference.kind === 'cite') {
      // Pandoc citation keys accept our slug charset unchanged.
      result +=
        reference.argument === undefined
          ? `[@${reference.slug}]`
          : `[@${reference.slug}, ${reference.argument}]`;
      continue;
    }

    const key = `${targetKind(reference.kind)}:${reference.slug}`;
    const label = reference.argument ?? titles.get(key) ?? reference.slug.replace(/-/g, ' ');
    const anchor = sectionAnchors.get(key);
    result += anchor === undefined ? label : `[${label}](#${anchor})`;
  }

  return result + markdown.slice(cursor);
}

/** A stable, Pandoc-safe anchor for a section heading. */
export function sectionAnchor(kind: string, slug: string): string {
  return `sec-${kind}-${slug}`;
}

/**
 * Builds the whole document for one audience.
 *
 * The `viewer` argument is the safety mechanism: a public build is assembled
 * with an anonymous viewer, so it can only contain sections that viewer could
 * already read one page at a time.
 */
export async function assembleDocument(
  db: Pool | PoolConnection,
  manuscript: ManuscriptRecord,
  viewer: Viewer,
): Promise<AssembledDocument> {
  const sections = await listSections(db, manuscript.id, viewer);

  const bodies = new Map<number, string>();
  if (sections.length > 0) {
    const placeholders = sections.map(() => '?').join(', ');
    const rows = await queryRows<
      RowDataPacket & { content_item_id: number; body_markdown: string }
    >(
      db,
      `SELECT content_item_id, body_markdown FROM essay_detail
        WHERE content_item_id IN (${placeholders})`,
      sections.map((section) => section.itemId),
    );
    for (const row of rows) bodies.set(Number(row.content_item_id), String(row.body_markdown));
  }

  // Anchors let a mention of another section become a cross-reference.
  const anchors = new Map<string, string>();
  for (const section of sections) {
    anchors.set(`${section.kind}:${section.slug}`, sectionAnchor(section.kind, section.slug));
  }

  // Titles for every mention target, not just sections: a reference written
  // without display text must print the subject's name, not a de-hyphenated
  // slug. Resolved in one query across all bodies.
  const allReferences = [...bodies.values()].flatMap((body) => parseReferences(body));
  const resolved = await resolveTargets(db, allReferences);
  const titles = new Map([...resolved].map(([key, row]) => [key, row.title]));
  for (const section of sections) {
    // A section's title in this manuscript wins over its own title.
    titles.set(`${section.kind}:${section.slug}`, section.title);
  }

  const citedSlugs = new Set<string>();
  const parts: string[] = [];
  let wordCount = 0;

  const ordered = [
    ...sections.filter((section) => section.role === 'front_matter'),
    ...sections.filter((section) => section.role === 'body'),
    ...sections.filter((section) => section.role === 'appendix'),
    ...sections.filter((section) => section.role === 'back_matter'),
  ];

  for (const section of ordered) {
    const body = bodies.get(section.itemId) ?? '';
    for (const reference of parseReferences(body)) {
      if (reference.kind === 'cite') citedSlugs.add(reference.slug);
    }

    const heading = `${'#'.repeat(Math.min(section.depth + 1, 6))} ${section.title} {#${sectionAnchor(section.kind, section.slug)}}`;
    const transformed = referencesToPandoc(
      demoteHeadings(body, section.depth + 1),
      anchors,
      titles,
    );

    parts.push(`${heading}\n\n${transformed.trim()}`);
    wordCount += countWords(body);
  }

  // Only sources the viewer may see reach the bibliography. A citation to a
  // source they may not see is dropped from the reference list and reported,
  // rather than disclosing its title in a footnote.
  const bibliography: CslItem[] = [];
  const withheldCitations: string[] = [];

  if (citedSlugs.size > 0) {
    const slugs = [...citedSlugs];
    const placeholders = slugs.map(() => '?').join(', ');
    const visible = visibilityFilter(viewer, 'ci');
    const rows = await queryRows<RowDataPacket & { slug: string; csl_json: unknown }>(
      db,
      `SELECT ci.slug, sd.csl_json
         FROM content_item ci
         JOIN source_detail sd ON sd.content_item_id = ci.id
        WHERE ci.kind = 'source' AND ci.slug IN (${placeholders}) AND ${visible.sql}`,
      [...slugs, ...visible.params],
    );

    const found = new Set(rows.map((row) => String(row.slug)));
    for (const row of rows) bibliography.push(parseStoredCslItem(row.csl_json));
    for (const slug of slugs) if (!found.has(slug)) withheldCitations.push(slug);
  }

  return {
    markdown: parts.join('\n\n'),
    bibliography,
    sectionCount: ordered.length,
    wordCount,
    withheldCitations,
  };
}
