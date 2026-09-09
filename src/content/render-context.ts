/**
 * Resolving the references in a body for one viewer.
 *
 * Used by the published page, by the admin preview and by the essay editor's
 * warnings, so all three agree about what a given reader will actually see.
 * Having one implementation is the point: a preview that resolved references
 * differently from the published page would be worse than no preview.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { queryRows, type Pool, type PoolConnection } from '../db/pool.js';
import { parseStoredCslItem } from '../citations/csl.js';
import type { ReferenceTarget } from './markdown.js';
import { parseReferences } from './references.js';
import { resolveTargets } from './mentions.js';
import { isAdmin, type Viewer } from './visibility.js';

export async function resolveForRender(
  db: Pool | PoolConnection,
  markdown: string,
  viewer: Viewer,
): Promise<Map<string, ReferenceTarget>> {
  const rows = await resolveTargets(db, parseReferences(markdown));

  // Citations need the bibliographic record to render a footnote; nothing
  // else does, so only sources are fetched.
  const sourceIds = [...rows.values()].filter((row) => row.kind === 'source').map((row) => row.id);
  const csl = new Map<number, ReturnType<typeof parseStoredCslItem>>();

  if (sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => '?').join(', ');
    const cslRows = await queryRows<RowDataPacket & { content_item_id: number; csl_json: unknown }>(
      db,
      `SELECT content_item_id, csl_json FROM source_detail WHERE content_item_id IN (${placeholders})`,
      sourceIds,
    );
    for (const row of cslRows) {
      csl.set(Number(row.content_item_id), parseStoredCslItem(row.csl_json));
    }
  }

  const targets = new Map<string, ReferenceTarget>();
  for (const [key, row] of rows) {
    targets.set(key, {
      id: row.id,
      kind: row.kind,
      slug: row.slug,
      title: row.title,
      // The one decision: may this viewer see the target at all? Everything
      // the renderer does about links, titles and footnotes follows from it.
      visible: isAdmin(viewer) || row.visibility === 'public',
      csl: csl.get(row.id),
    });
  }

  return targets;
}
