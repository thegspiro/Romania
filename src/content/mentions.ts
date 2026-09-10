/**
 * Mentions and citations as projections of prose.
 *
 * `rebuildReferences` is the only thing that writes the `mention` and
 * `citation` tables for an item, and it runs in the same transaction as the
 * save that changed the text. Nothing edits these rows by hand.
 *
 * That is what makes "everywhere this person is mentioned" trustworthy: the
 * listing is derived from the prose and cannot drift from it. It also means a
 * reference removed from an essay disappears from the target's page
 * immediately, with no reconciliation step to forget to run.
 *
 * Backlink reads are visibility-filtered on the *citing* item: a private essay
 * mentioning a public person must not appear on that person's public page.
 */
import type { RowDataPacket } from 'mysql2/promise';
import {
  execute,
  limitOffsetClause,
  queryRows,
  type Pool,
  type PoolConnection,
} from '../db/pool.js';
import { visibilityFilter, type Viewer } from './visibility.js';
import { blockAnchorsFor } from './markdown.js';
import {
  extractContext,
  parseReferences,
  referenceHref,
  targetKind,
  type ParsedReference,
} from './references.js';

export interface ResolvedTargetRow {
  id: number;
  kind: string;
  slug: string;
  title: string;
  visibility: 'private' | 'public';
}

/**
 * Looks up every distinct reference target in one query.
 *
 * No visibility filter here: resolution must find the row so the renderer can
 * decide between a link and plain text. The viewer check happens at render
 * time, in one place.
 */
export async function resolveTargets(
  db: Pool | PoolConnection,
  references: readonly ParsedReference[],
): Promise<Map<string, ResolvedTargetRow>> {
  const wanted = new Map<string, { kind: string; slug: string }>();
  for (const reference of references) {
    const kind = targetKind(reference.kind);
    wanted.set(`${kind}:${reference.slug}`, { kind, slug: reference.slug });
  }
  if (wanted.size === 0) return new Map();

  // One placeholder pair per target. Only "(?, ?)" repetitions are written
  // into the SQL; every value is bound.
  const pairs = [...wanted.values()];
  const placeholders = pairs.map(() => '(?, ?)').join(', ');
  const params = pairs.flatMap((entry) => [entry.kind, entry.slug]);

  const rows = await queryRows<RowDataPacket & ResolvedTargetRow>(
    db,
    `SELECT id, kind, slug, title, visibility
       FROM content_item
      WHERE (kind, slug) IN (${placeholders})`,
    params,
  );

  return new Map(rows.map((row) => [`${row.kind}:${row.slug}`, row]));
}

export interface RebuildResult {
  mentions: number;
  citations: number;
  /** References whose target does not exist, for the operator to fix. */
  unresolved: { kind: string; slug: string }[];
  /** Cited sources that are still private, warned about before publishing. */
  privateCitations: { slug: string; title: string }[];
}

/**
 * Rebuilds the projections for one item from its prose.
 *
 * Must be called inside the same transaction as the write that changed
 * `markdown`, so the rows and the text can never disagree.
 */
export async function rebuildReferences(
  connection: PoolConnection,
  itemId: number,
  markdown: string,
): Promise<RebuildResult> {
  const references = parseReferences(markdown);
  const targets = await resolveTargets(connection, references);

  // Which paragraph each reference sits in, so a backlink can land on the
  // sentence that named the target rather than the top of the page. Computed
  // from the same block numbering the renderer emits as `id="pN"`, and stored
  // here rather than derived on read because this is the only moment the text
  // and the row are guaranteed to be the same version.
  const anchors = blockAnchorsFor(
    markdown,
    references.map((reference) => reference.index),
  );

  // Titles let a reference with no display text read as its subject's name
  // in the context snippet, rather than as a de-hyphenated slug.
  const titles = new Map([...targets].map(([key, row]) => [key, row.title]));

  // Replace wholesale rather than diff: the text is the truth, and a diff
  // would be a second place for the two to fall out of step.
  await execute(connection, 'DELETE FROM mention WHERE from_item_id = ?', [itemId]);
  await execute(connection, 'DELETE FROM citation WHERE citing_item_id = ?', [itemId]);

  const unresolved: { kind: string; slug: string }[] = [];
  const privateCitations: { slug: string; title: string }[] = [];
  const occurrences = new Map<number, number>();
  let mentions = 0;
  let citations = 0;
  let citationOrder = 0;

  for (const [position, reference] of references.entries()) {
    const target = targets.get(`${targetKind(reference.kind)}:${reference.slug}`);
    if (target === undefined) {
      unresolved.push({ kind: targetKind(reference.kind), slug: reference.slug });
      continue;
    }

    // An item referring to itself is not a mention; the schema forbids it and
    // it would only produce a self-link.
    if (target.id === itemId) continue;

    if (reference.kind === 'cite') {
      await execute(
        connection,
        `INSERT INTO citation (citing_item_id, source_item_id, label, locator, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
        [
          itemId,
          target.id,
          reference.argument === undefined ? null : 'page',
          reference.argument ?? null,
          citationOrder,
        ],
      );
      citationOrder += 1;
      citations += 1;
      if (target.visibility !== 'public') {
        privateCitations.push({ slug: target.slug, title: target.title });
      }
      continue;
    }

    const occurrence = occurrences.get(target.id) ?? 0;
    occurrences.set(target.id, occurrence + 1);

    await execute(
      connection,
      `INSERT INTO mention
         (from_item_id, to_item_id, occurrence, block_index, anchor_text, context)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        itemId,
        target.id,
        occurrence,
        anchors[position] ?? null,
        (reference.argument ?? target.title).slice(0, 500),
        extractContext(markdown, reference, { titles }).slice(0, 1000),
      ],
    );
    mentions += 1;
  }

  return { mentions, citations, unresolved, privateCitations };
}

// --- Backlinks -------------------------------------------------------------

export interface Backlink {
  itemId: number;
  kind: string;
  slug: string;
  title: string;
  /**
   * Where to read it. Carries a `#pN` fragment when the first mention's
   * paragraph is known, so the link lands on the sentence rather than the top
   * of a long essay.
   */
  href: string;
  /** How the prose named the target at its first occurrence here. */
  anchorText: string;
  context: string | null;
  occurrences: number;
  /** 1-based top-level block of the citing prose, or null for older rows. */
  blockIndex: number | null;
}

/** A backlink's URL, pointing at the paragraph when one is recorded. */
function backlinkHref(kind: string, slug: string, blockIndex: number | null): string {
  const base = referenceHref(kind, slug);
  return blockIndex === null ? base : `${base}#p${blockIndex}`;
}

/**
 * Everywhere an item is mentioned, restricted to what the viewer may see.
 *
 * This is the query behind "connect them to an individual, then see the other
 * places they have been mentioned". The filter is on the *citing* item, so a
 * private essay never surfaces on a public entity's page -- not its title, not
 * its slug, and not a context snippet quoting it.
 */
export async function listMentionsOf(
  db: Pool | PoolConnection,
  itemId: number,
  viewer: Viewer,
  limit = 200,
): Promise<Backlink[]> {
  const visible = visibilityFilter(viewer, 'ci');

  const rows = await queryRows<
    RowDataPacket & {
      item_id: number;
      kind: string;
      slug: string;
      title: string;
      anchor_text: string;
      context: string | null;
      occurrences: number;
      block_index: number | null;
    }
  >(
    db,
    // Joining the occurrence-0 row gives the FIRST mention's wording and
    // context. An aggregate such as MIN() would pick alphabetically, which
    // shows the reader a sentence from the middle of the piece for no reason.
    // Its block index comes from the same row, so the quoted sentence and the
    // paragraph the link opens are the same one.
    `SELECT ci.id AS item_id, ci.kind, ci.slug, ci.title,
            first_mention.anchor_text AS anchor_text,
            first_mention.context AS context,
            first_mention.block_index AS block_index,
            COUNT(*) AS occurrences
       FROM mention m
       JOIN content_item ci ON ci.id = m.from_item_id
       JOIN mention first_mention
         ON first_mention.from_item_id = m.from_item_id
        AND first_mention.to_item_id = m.to_item_id
        AND first_mention.occurrence = 0
      WHERE m.to_item_id = ? AND ${visible.sql}
      GROUP BY ci.id, ci.kind, ci.slug, ci.title,
               first_mention.anchor_text, first_mention.context,
               first_mention.block_index
      ORDER BY ci.title ASC
      ${limitOffsetClause(Math.min(Math.max(Math.trunc(limit), 1), 500))}`,
    [itemId, ...visible.params],
  );

  return rows.map((row) => {
    const blockIndex = row.block_index === null ? null : Number(row.block_index);
    return {
      itemId: row.item_id,
      kind: row.kind,
      slug: row.slug,
      title: row.title,
      href: backlinkHref(row.kind, row.slug, blockIndex),
      anchorText: row.anchor_text,
      context: row.context,
      occurrences: Number(row.occurrences),
      blockIndex,
    };
  });
}

/** How many visible items mention this one. Used for listings and the graph. */
export async function countMentionsOf(
  db: Pool | PoolConnection,
  itemId: number,
  viewer: Viewer,
): Promise<number> {
  const visible = visibilityFilter(viewer, 'ci');
  const rows = await queryRows<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(DISTINCT m.from_item_id) AS total
       FROM mention m
       JOIN content_item ci ON ci.id = m.from_item_id
      WHERE m.to_item_id = ? AND ${visible.sql}`,
    [itemId, ...visible.params],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Items this one refers to, for "also discussed here" navigation. */
export async function listMentionsFrom(
  db: Pool | PoolConnection,
  itemId: number,
  viewer: Viewer,
): Promise<Backlink[]> {
  const visible = visibilityFilter(viewer, 'ci');
  const rows = await queryRows<
    RowDataPacket & {
      item_id: number;
      kind: string;
      slug: string;
      title: string;
      anchor_text: string;
      occurrences: number;
    }
  >(
    db,
    `SELECT ci.id AS item_id, ci.kind, ci.slug, ci.title,
            MIN(m.anchor_text) AS anchor_text,
            COUNT(*) AS occurrences
       FROM mention m
       JOIN content_item ci ON ci.id = m.to_item_id
      WHERE m.from_item_id = ? AND ${visible.sql}
      GROUP BY ci.id, ci.kind, ci.slug, ci.title
      ORDER BY ci.kind ASC, ci.title ASC`,
    [itemId, ...visible.params],
  );

  return rows.map((row) => ({
    itemId: row.item_id,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    // The target's own page, not a paragraph of this one: the anchor belongs
    // to the prose that did the mentioning, which is where the reader already
    // is.
    href: referenceHref(row.kind, row.slug),
    anchorText: row.anchor_text,
    context: null,
    occurrences: Number(row.occurrences),
    blockIndex: null,
  }));
}

/**
 * Items blocking deletion of this one, because their prose still names it.
 *
 * The `mention` and `citation` foreign keys are RESTRICT, so the database
 * would refuse the delete anyway; this turns that into a message naming what
 * to edit. Deliberately NOT visibility-filtered: the operator is the only
 * caller, and a private essay is exactly the one they would otherwise not
 * think to look in.
 */
export async function listReferencesBlockingDeletion(
  db: Pool | PoolConnection,
  itemId: number,
): Promise<{ kind: string; slug: string; title: string; relation: 'mention' | 'citation' }[]> {
  const rows = await queryRows<
    RowDataPacket & { kind: string; slug: string; title: string; relation: 'mention' | 'citation' }
  >(
    db,
    `SELECT ci.kind, ci.slug, ci.title, 'mention' AS relation
       FROM mention m JOIN content_item ci ON ci.id = m.from_item_id
      WHERE m.to_item_id = ?
      UNION
     SELECT ci.kind, ci.slug, ci.title, 'citation' AS relation
       FROM citation c JOIN content_item ci ON ci.id = c.citing_item_id
      WHERE c.source_item_id = ?
      ORDER BY title ASC`,
    [itemId, itemId],
  );
  return rows;
}
