/**
 * File records and the access rule for serving bytes.
 *
 * `findServableFile` is invariant 3 of CLAUDE.md in one function: file bytes
 * are reachable only through a lookup that re-checks the owning item's
 * visibility, on every request, with no caching of the decision.
 *
 * It joins through `artifact_detail`, so a `file_object` that no artifact
 * owns -- a compiled manuscript, for instance -- is not servable here at all.
 * Those have their own admin-only route, which checks the build's audience.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { execute, queryOne, type Pool, type PoolConnection } from '../db/pool.js';
import { visibilityFilter, type Viewer } from './../content/visibility.js';

export interface FileObjectRecord {
  id: number;
  sha256: string;
  byteSize: number;
  mimeType: string;
  originalFilename: string;
  storageKey: string;
}

export async function insertFileObject(
  db: Pool | PoolConnection,
  input: {
    sha256: string;
    byteSize: number;
    mimeType: string;
    originalFilename: string;
    storageKey: string;
  },
): Promise<number> {
  // Content-addressed, so re-uploading identical bytes must reuse the row
  // rather than colliding on the unique key.
  const existing = await queryOne<RowDataPacket & { id: number }>(
    db,
    'SELECT id FROM file_object WHERE sha256 = ?',
    [input.sha256],
  );
  if (existing !== null) return Number(existing.id);

  const result = await execute(
    db,
    `INSERT INTO file_object (sha256, byte_size, mime_type, original_filename, storage_key)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.sha256,
      input.byteSize,
      input.mimeType,
      input.originalFilename.slice(0, 255),
      input.storageKey,
    ],
  );
  return result.insertId;
}

export async function findFileObject(
  db: Pool | PoolConnection,
  id: number,
): Promise<FileObjectRecord | null> {
  const row = await queryOne<RowDataPacket>(
    db,
    'SELECT id, sha256, byte_size, mime_type, original_filename, storage_key FROM file_object WHERE id = ?',
    [id],
  );
  if (row === null) return null;
  return {
    id: Number(row.id),
    sha256: String(row.sha256),
    byteSize: Number(row.byte_size),
    mimeType: String(row.mime_type),
    originalFilename: String(row.original_filename),
    storageKey: String(row.storage_key),
  };
}

export interface ServableFile {
  mimeType: string;
  byteSize: number;
  storageKey: string;
  originalFilename: string;
  /** Used for ETag and cache validation. */
  sha256: string;
}

/**
 * Resolves a file for serving, or null when the viewer may not have it.
 *
 * Returns null for every failure mode -- unknown id, unknown variant, private
 * owner, no owning artifact -- so the route can answer 404 uniformly and never
 * distinguish "does not exist" from "not yours".
 */
export async function findServableFile(
  db: Pool | PoolConnection,
  fileObjectId: number,
  variant: string,
  viewer: Viewer,
): Promise<ServableFile | null> {
  const visible = visibilityFilter(viewer, 'ci');

  if (variant === 'original') {
    const row = await queryOne<RowDataPacket>(
      db,
      `SELECT fo.mime_type, fo.byte_size, fo.storage_key, fo.original_filename, fo.sha256
         FROM file_object fo
         JOIN artifact_detail ad ON ad.file_object_id = fo.id
         JOIN content_item ci ON ci.id = ad.content_item_id
        WHERE fo.id = ? AND ${visible.sql}
        LIMIT 1`,
      [fileObjectId, ...visible.params],
    );
    if (row === null) return null;
    return {
      mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size),
      storageKey: String(row.storage_key),
      originalFilename: String(row.original_filename),
      sha256: String(row.sha256),
    };
  }

  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT fd.mime_type, fd.byte_size, fd.storage_key, fo.original_filename, fo.sha256
       FROM file_derivative fd
       JOIN file_object fo ON fo.id = fd.file_object_id
       JOIN artifact_detail ad ON ad.file_object_id = fo.id
       JOIN content_item ci ON ci.id = ad.content_item_id
      WHERE fd.file_object_id = ? AND fd.variant = ? AND ${visible.sql}
      LIMIT 1`,
    [fileObjectId, variant, ...visible.params],
  );
  if (row === null) return null;
  return {
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    storageKey: String(row.storage_key),
    originalFilename: String(row.original_filename),
    sha256: String(row.sha256),
  };
}

/** Queues derivative generation for a newly stored file. */
export async function enqueueDerivatives(
  db: Pool | PoolConnection,
  fileObjectId: number,
): Promise<void> {
  await execute(
    db,
    `INSERT INTO job (kind, payload) VALUES ('file.derivatives', CAST(? AS JSON))`,
    [JSON.stringify({ fileObjectId })],
  );
}
