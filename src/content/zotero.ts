/**
 * Zotero sync, from the web service's side.
 *
 * The division of labour is the same one compilation uses: the web service
 * decides that a sync should happen and records it; the worker is the only
 * thing that talks to the Zotero API. Nothing here holds the API key, and
 * nothing here parses a bibliographic record.
 *
 * What this module owns is the queue entry, the state the admin listing
 * displays, and the list of links Zotero has reported deleted. All of it is
 * administrative bookkeeping about the library, not content, so none of it
 * takes a `Viewer` -- these functions are reachable only from routes behind
 * the admin guard, and `listZoteroDeletedSourceIds` deliberately returns bare
 * ids that the caller has already fetched through `listSources`.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { execute, queryOne, queryRows, withTransaction, type Pool } from '../db/pool.js';
import type { Config } from '../config.js';

export type ZoteroLibraryType = 'user' | 'group';

export interface ZoteroLibrary {
  libraryType: ZoteroLibraryType;
  libraryId: string;
}

/**
 * The configured library, or null when sync is switched off.
 *
 * The web service cannot tell whether the worker has an API key -- that is
 * deliberately the worker's alone -- so a configured library is as much as
 * this side can assert. A key that is missing or wrong fails the job, with
 * the reason on the job row.
 */
export function configuredLibrary(config: Config): ZoteroLibrary | null {
  if (config.ZOTERO_LIBRARY_ID === undefined) return null;
  return {
    libraryType: config.ZOTERO_LIBRARY_TYPE,
    libraryId: config.ZOTERO_LIBRARY_ID,
  };
}

export interface ZoteroSyncState {
  lastVersion: number;
  lastSyncedAt: Date | null;
  createdCount: number;
  updatedCount: number;
  linkedCount: number;
  deletedCount: number;
}

export async function findSyncState(
  pool: Pool,
  library: ZoteroLibrary,
): Promise<ZoteroSyncState | null> {
  const row = await queryOne<RowDataPacket>(
    pool,
    `SELECT last_version, last_synced_at, created_count, updated_count,
            linked_count, deleted_count
       FROM zotero_library_state
      WHERE library_type = ? AND library_id = ?`,
    [library.libraryType, library.libraryId],
  );
  if (row === null) return null;

  return {
    lastVersion: Number(row.last_version ?? 0),
    lastSyncedAt: (row.last_synced_at as Date | null) ?? null,
    createdCount: Number(row.created_count ?? 0),
    updatedCount: Number(row.updated_count ?? 0),
    linkedCount: Number(row.linked_count ?? 0),
    deletedCount: Number(row.deleted_count ?? 0),
  };
}

/**
 * Sources whose Zotero item has been deleted, for the review flag.
 *
 * Ids only. The listing already holds the sources themselves, filtered
 * through `visibilityFilter`, so returning ids cannot widen what that page
 * shows -- an id with no row beside it renders nothing.
 */
export async function listZoteroDeletedSourceIds(pool: Pool): Promise<number[]> {
  const rows = await queryRows<RowDataPacket>(
    pool,
    `SELECT content_item_id FROM source_zotero_link
      WHERE deleted_in_zotero_at IS NOT NULL`,
  );
  return rows.map((row) => Number(row.content_item_id));
}

export type SyncRequestOutcome = 'queued' | 'already_queued';

/**
 * Queues a sync, unless one is already waiting.
 *
 * The guard is a convenience, not a lock: two requests arriving together can
 * both find the queue empty and enqueue. That is harmless -- a sync is an
 * upsert keyed on the Zotero item key, so running it twice reaches the same
 * result as running it once -- and a real lock would be a lot of machinery to
 * avoid a duplicate job that costs one HTTP request.
 */
export async function requestZoteroSync(
  pool: Pool,
  options: { full: boolean },
): Promise<SyncRequestOutcome> {
  return withTransaction(pool, async (connection) => {
    const pending = await queryOne<RowDataPacket & { id: number }>(
      connection,
      `SELECT id FROM job
        WHERE kind = 'zotero.sync' AND state IN ('pending', 'running')
        LIMIT 1`,
    );
    if (pending !== null) return 'already_queued';

    await execute(
      connection,
      `INSERT INTO job (kind, payload) VALUES ('zotero.sync', CAST(? AS JSON))`,
      [JSON.stringify({ full: options.full })],
    );
    return 'queued';
  });
}
