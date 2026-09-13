/**
 * Moving a corpus from one storage backend to another.
 *
 * Switching `STORAGE_BACKEND` changes where bytes are looked for, not where
 * they are. Without this, flipping that value turns every existing file into a
 * 404 -- which for a corpus of archival scans is the failure that matters
 * most, and the one an operator would discover from a reader rather than from
 * a log.
 *
 * Three properties, each of which the tests pin:
 *
 *   - **It is driven by the database, not by a directory walk.** The rows in
 *     `file_object` and `file_derivative` are the record of what this
 *     application believes it stored; a file on disk that no row points at is
 *     not part of the corpus and copying it would import somebody's stray
 *     backup into the bucket.
 *   - **It is re-runnable.** Every object is content-addressed, so one already
 *     present is byte-for-byte the one that would be written. It is skipped,
 *     and an interrupted run is simply run again.
 *   - **It never deletes from the source.** The old backend stays intact and
 *     complete, so an operator who switches and regrets it switches back.
 *     Reclaiming that space is a decision to make later, by hand, once the new
 *     backend has been seen to work.
 */
import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { queryRows, type Pool } from '../db/pool.js';
import { StorageObjectNotFoundError, type StorageBackend } from './backend.js';

export interface MigrationSummary {
  /** Keys the target already held, byte-for-byte. */
  skipped: number;
  copied: number;
  /** Keys the source does not hold. Reported, never fatal. */
  missing: string[];
  /** Keys whose bytes did not survive the copy. Fatal if non-empty. */
  corrupted: string[];
  bytes: number;
}

export interface MigrateOptions {
  /** Report what would happen and copy nothing. */
  dryRun?: boolean;
  /** Re-read each copied object and check its hash. Slower, and sure. */
  verify?: boolean;
  onProgress?: (done: number, total: number, key: string) => void;
}

/** Every storage key the database believes exists, in a stable order. */
export async function storageKeysInUse(pool: Pool): Promise<string[]> {
  const rows = await queryRows<RowDataPacket & { storage_key: string }>(
    pool,
    `SELECT storage_key FROM file_object
     UNION
     SELECT storage_key FROM file_derivative
     ORDER BY storage_key`,
    [],
  );
  return rows.map((row) => String(row.storage_key));
}

async function readAll(backend: StorageBackend, key: string): Promise<Buffer> {
  const stream = await backend.openRead(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Copies every key the database knows about from `source` to `target`.
 *
 * Whole objects are read into memory one at a time. That is the right trade
 * here and not an oversight: the largest thing in this corpus is bounded by
 * `UPLOAD_MAX_BYTES`, the copy is a one-off an operator watches, and a
 * streaming copy would give up the thing that makes this safe to interrupt --
 * knowing the bytes arrived intact before the next key is attempted.
 */
export async function migrateStorage(
  pool: Pool,
  source: StorageBackend,
  target: StorageBackend,
  options: MigrateOptions = {},
): Promise<MigrationSummary> {
  const keys = await storageKeysInUse(pool);
  const summary: MigrationSummary = {
    skipped: 0,
    copied: 0,
    missing: [],
    corrupted: [],
    bytes: 0,
  };

  let done = 0;
  for (const key of keys) {
    done += 1;
    options.onProgress?.(done, keys.length, key);

    if (await target.exists(key)) {
      summary.skipped += 1;
      continue;
    }

    let contents: Buffer;
    try {
      contents = await readAll(source, key);
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        // A row pointing at bytes that are not there is a pre-existing
        // problem this command reports rather than one it causes. Copying
        // stops for this key only: the rest of the corpus still moves.
        summary.missing.push(key);
        continue;
      }
      throw error;
    }

    if (options.dryRun === true) {
      summary.copied += 1;
      summary.bytes += contents.length;
      continue;
    }

    await target.put(key, contents);

    if (options.verify === true) {
      const written = await readAll(target, key);
      const before = createHash('sha256').update(contents).digest('hex');
      const after = createHash('sha256').update(written).digest('hex');
      if (before !== after) {
        summary.corrupted.push(key);
        continue;
      }
    }

    summary.copied += 1;
    summary.bytes += contents.length;
  }

  return summary;
}
