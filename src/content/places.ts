/**
 * Places on a map.
 *
 * `place_detail` has carried coordinates since the first schema; this is the
 * read that turns them into something drawable, and the queue call that fills
 * them in.
 *
 * Nothing here decides visibility for itself. The map is a second presentation
 * of rows the place pages already show, so it goes through `visibilityFilter`
 * like every other read -- a private place is absent from the overview in the
 * same way it is absent from the listing, with no gap and no marker saying
 * something was withheld.
 *
 * Coordinates are the one field where being approximately right is worse than
 * being silent, so `geocode_precision` travels with every point and the marker
 * says which it is. A town geocoded to its modern centre is not evidence about
 * where a building stood in 1941.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { execute, queryOne, queryRows, withTransaction, type Pool } from '../db/pool.js';
import type { PoolConnection } from '../db/pool.js';
import { visibilityFilter, type Viewer, type Visibility } from './visibility.js';

/** How precisely a point locates something. */
export type GeocodePrecision = 'exact' | 'approximate' | 'region' | 'unknown';

export interface MappablePlace {
  id: number;
  slug: string;
  title: string;
  latitude: number;
  longitude: number;
  precision: GeocodePrecision;
  /** Null for a place whose coordinates were typed rather than looked up. */
  geocodedAt: string | null;
  visibility: Visibility;
  href: string;
}

/**
 * A hard ceiling on how many points one map may carry.
 *
 * A dissertation's gazetteer is hundreds of places, not thousands, and a map
 * that silently tries to draw everything is how a page stops responding on a
 * phone. The count of places with coordinates is reported separately, so the
 * page can say plainly when it is showing a subset rather than quietly
 * truncating.
 */
export const MAX_MAP_POINTS = 500;

interface PlaceRow extends RowDataPacket {
  id: number;
  slug: string;
  title: string;
  latitude: string | number;
  longitude: string | number;
  geocode_precision: string;
  geocoded_at: Date | null;
  visibility: string;
}

function toPlace(row: PlaceRow): MappablePlace {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    // DECIMAL comes back as a string from mysql2, which would serialise into
    // JSON as "47.156600" and reach Leaflet as a string it cannot add.
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    precision: (row.geocode_precision as GeocodePrecision) ?? 'unknown',
    geocodedAt: row.geocoded_at === null ? null : row.geocoded_at.toISOString(),
    visibility: row.visibility as Visibility,
    href: `/places/${row.slug}`,
  };
}

export interface MappablePlaces {
  places: MappablePlace[];
  /** How many the viewer may see in total, before the ceiling applied. */
  total: number;
}

/**
 * Every place the viewer may see that has coordinates.
 *
 * A place without coordinates is not a point and is simply not here -- the
 * absence carries no information, because an unmapped place looks exactly like
 * one that does not exist.
 */
export async function listMappablePlaces(
  db: Pool | PoolConnection,
  viewer: Viewer,
  limit = MAX_MAP_POINTS,
): Promise<MappablePlaces> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_MAP_POINTS);
  const visible = visibilityFilter(viewer, 'ci');

  const where = `WHERE ci.kind = 'place'
                   AND ${visible.sql}
                   AND d.latitude IS NOT NULL
                   AND d.longitude IS NOT NULL`;

  const totalRow = await queryOne<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(*) AS total
       FROM content_item ci
       JOIN place_detail d ON d.content_item_id = ci.id
      ${where}`,
    visible.params,
  );

  const rows = await queryRows<PlaceRow>(
    db,
    `SELECT ci.id, ci.slug, ci.title, ci.visibility,
            d.latitude, d.longitude, d.geocode_precision, d.geocoded_at
       FROM content_item ci
       JOIN place_detail d ON d.content_item_id = ci.id
      ${where}
      ORDER BY ci.title ASC, ci.id ASC
      LIMIT ${bounded}`,
    visible.params,
  );

  return { places: rows.map(toPlace), total: Number(totalRow?.total ?? 0) };
}

/**
 * One place, if the viewer may see it and it has coordinates.
 *
 * Used by the place page, which has already loaded the record through the
 * entity repository; this exists so the marker is built from the same shape
 * the overview uses rather than from template locals.
 */
export async function findMappablePlace(
  db: Pool | PoolConnection,
  viewer: Viewer,
  id: number,
): Promise<MappablePlace | null> {
  const visible = visibilityFilter(viewer, 'ci');
  const row = await queryOne<PlaceRow>(
    db,
    `SELECT ci.id, ci.slug, ci.title, ci.visibility,
            d.latitude, d.longitude, d.geocode_precision, d.geocoded_at
       FROM content_item ci
       JOIN place_detail d ON d.content_item_id = ci.id
      WHERE ci.kind = 'place'
        AND ci.id = ?
        AND ${visible.sql}
        AND d.latitude IS NOT NULL
        AND d.longitude IS NOT NULL`,
    [id, ...visible.params],
  );
  return row === null ? null : toPlace(row);
}

export type GeocodeRequestOutcome = 'queued' | 'already_queued';

/**
 * Queues a geocoding lookup for one place.
 *
 * The web service never calls Nominatim: it enqueues, and `worker/jobs/
 * geocode.py` does the work, for the same reason the Zotero key lives only in
 * the worker. The handler already refuses to overwrite coordinates that were
 * entered by hand, so a stray click cannot replace the operator's own
 * judgement about where something was.
 *
 * The pending check is a convenience rather than a lock, exactly as in
 * `requestZoteroSync`: two clicks arriving together can both enqueue, and a
 * duplicate lookup costs one HTTP request and reaches the same result.
 */
export async function requestGeocode(pool: Pool, placeId: number): Promise<GeocodeRequestOutcome> {
  if (!Number.isSafeInteger(placeId) || placeId <= 0) {
    throw new TypeError(`Invalid place id: ${String(placeId)}`);
  }

  return withTransaction(pool, async (connection) => {
    const pending = await queryOne<RowDataPacket & { id: number }>(
      connection,
      `SELECT id FROM job
        WHERE kind = 'place.geocode'
          AND state IN ('pending', 'running')
          AND CAST(payload ->> '$.contentItemId' AS UNSIGNED) = ?
        LIMIT 1`,
      [placeId],
    );
    if (pending !== null) return 'already_queued';

    await execute(
      connection,
      `INSERT INTO job (kind, payload) VALUES ('place.geocode', CAST(? AS JSON))`,
      // The key is the worker's, not this module's: geocode.py reads
      // payload.contentItemId and raises on anything else.
      [JSON.stringify({ contentItemId: placeId })],
    );
    return 'queued';
  });
}
