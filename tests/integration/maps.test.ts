/**
 * Places on a map.
 *
 * The map is a second presentation of rows the place pages already show, so
 * most of what needs pinning is that it stayed a presentation: the read goes
 * through `visibilityFilter`, a private place is absent rather than withheld
 * with a gap, and the JSON endpoint is not a way around either.
 *
 * The other half is the tile host. Maps are the first feature that can make
 * the browser talk to somebody other than this server, so the CSP and the
 * default-off setting are asserted here rather than assumed: unset, the policy
 * is exactly what it was before maps existed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createHarness,
  databaseAvailable,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { queryRows } from '../../src/db/pool.js';
import type { RowDataPacket } from 'mysql2/promise';
import { listMappablePlaces, requestGeocode } from '../../src/content/places.js';
import { createEntity } from '../../src/content/entities.js';
import { adminViewer, ANONYMOUS, type Visibility } from '../../src/content/visibility.js';
import { contentSecurityPolicy, tileOrigin } from '../../src/http/security.js';
import { loadConfig } from '../../src/config.js';
import { testConfig } from './helpers.js';

const available = await databaseAvailable();

describe.skipIf(!available)('maps', () => {
  let harness: Harness;
  let admin: Map<string, string>;
  const viewer = adminViewer(1);

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
    admin = await signIn(harness);
  });

  async function place(
    title: string,
    visibility: Visibility,
    coordinates: { latitude?: string; longitude?: string; precision?: string } = {},
  ): Promise<number> {
    const { id } = await createEntity(harness.pool, 'place', {
      title,
      titleOriginal: '',
      language: '',
      summary: '',
      visibility,
      noindex: false,
      detail: {
        latitude: coordinates.latitude ?? '47.1585',
        longitude: coordinates.longitude ?? '27.6014',
        geocodePrecision: coordinates.precision ?? 'approximate',
      },
    });
    return id;
  }

  describe('what the map may show', () => {
    it('omits a private place from an anonymous viewer', async () => {
      await place('Iasi', 'public');
      await place('A safe house', 'private');

      const asAdmin = await listMappablePlaces(harness.pool, viewer);
      expect(asAdmin.places.map((entry) => entry.title)).toEqual(['A safe house', 'Iasi']);

      const asAnyone = await listMappablePlaces(harness.pool, ANONYMOUS);
      expect(asAnyone.places.map((entry) => entry.title)).toEqual(['Iasi']);
      // Absent, not withheld: the count matches what is drawn, so nothing on
      // the page says a place was left out.
      expect(asAnyone.total).toBe(1);
    });

    it('omits a place with no coordinates rather than plotting a guess', async () => {
      await createEntity(harness.pool, 'place', {
        title: 'Somewhere unlocated',
        titleOriginal: '',
        language: '',
        summary: '',
        visibility: 'public',
        noindex: false,
        detail: {},
      });

      const { places, total } = await listMappablePlaces(harness.pool, viewer);
      expect(places).toEqual([]);
      expect(total).toBe(0);
    });

    it('returns coordinates as numbers, not DECIMAL strings', async () => {
      await place('Iasi', 'public');
      const { places } = await listMappablePlaces(harness.pool, viewer);
      // mysql2 hands back DECIMAL as a string, which would reach Leaflet as
      // "47.158500" and be added to a number rather than plotted.
      expect(typeof places[0]?.latitude).toBe('number');
      expect(typeof places[0]?.longitude).toBe('number');
      expect(places[0]?.latitude).toBeCloseTo(47.1585, 4);
    });

    it('carries the precision so a region is not read as a building', async () => {
      await place('A county', 'public', { precision: 'region' });
      const { places } = await listMappablePlaces(harness.pool, viewer);
      expect(places[0]?.precision).toBe('region');
    });
  });

  describe('the JSON endpoint', () => {
    it('filters for the viewer, exactly as the page does', async () => {
      await place('Iasi', 'public');
      await place('A safe house', 'private');

      const anonymous = await harness.app.inject({ method: 'GET', url: '/map/places.json' });
      expect(anonymous.statusCode).toBe(200);
      const body: { places: { title: string }[]; total: number } = anonymous.json();
      expect(body.places.map((entry) => entry.title)).toEqual(['Iasi']);
      expect(JSON.stringify(body)).not.toContain('safe house');

      const asAdmin = await harness.app.inject({
        method: 'GET',
        url: '/map/places.json',
        headers: { cookie: cookieHeader(admin) },
      });
      const adminBody: { places: { title: string }[] } = asAdmin.json();
      expect(adminBody.places).toHaveLength(2);
    });

    it('is never stored by a shared cache', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/map/places.json' });
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  describe('the pages', () => {
    it('lists the same places under the map, so the script is optional', async () => {
      await place('Iasi', 'public');
      await place('A safe house', 'private');

      const response = await harness.app.inject({ method: 'GET', url: '/map' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Iasi');
      expect(response.body).not.toContain('safe house');
      // The list is server-rendered, so the coordinates are readable with no
      // JavaScript at all.
      expect(response.body).toContain('47.1585');
    });

    it('draws a marker on a place page that has coordinates', async () => {
      await place('Iasi', 'public');
      const response = await harness.app.inject({ method: 'GET', url: '/places/iasi' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('id="place-map"');
      expect(response.body).toContain('data-latitude="47.1585"');
    });

    it('leaves a place page without coordinates unchanged', async () => {
      await createEntity(harness.pool, 'place', {
        title: 'Somewhere unlocated',
        titleOriginal: '',
        language: '',
        summary: '',
        visibility: 'public',
        noindex: false,
        detail: {},
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/places/somewhere-unlocated',
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('id="place-map"');
      // No Leaflet is loaded where there is nothing to draw.
      expect(response.body).not.toContain('leaflet.js');
    });

    it('still 404s a private place for an anonymous viewer', async () => {
      await place('A safe house', 'private');
      const response = await harness.app.inject({
        method: 'GET',
        url: '/places/a-safe-house',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('the tile host', () => {
    it('adds nothing to the policy when no tile URL is configured', () => {
      const policy = contentSecurityPolicy('abc123');
      expect(policy).toContain("img-src 'self' data:;");
      expect(policy).not.toContain('http');
    });

    it('adds exactly the configured origin, and only to img-src', () => {
      const policy = contentSecurityPolicy('abc123', 'https://tiles.example.org');
      expect(policy).toContain("img-src 'self' data: https://tiles.example.org");
      expect(policy).toContain("script-src 'self' 'nonce-abc123'");
      expect(policy).toContain("connect-src 'self'");
      // The tile host may serve images and nothing else.
      expect(policy).not.toContain("connect-src 'self' https://tiles.example.org");
    });

    it('derives the origin from the tile template, dropping the placeholders', () => {
      const config = loadConfig({
        ...envFor(),
        MAP_TILE_URL: 'https://tiles.example.org/styles/v1/{z}/{x}/{y}.png',
        MAP_TILE_ATTRIBUTION: '© Example',
      });
      expect(tileOrigin(config)).toBe('https://tiles.example.org');
    });

    it('is null when unset, so the default contacts nobody', () => {
      expect(tileOrigin(loadConfig(envFor()))).toBeNull();
    });

    it('refuses a template with a {s} subdomain placeholder', () => {
      // A pattern in the host cannot become one CSP source: it would either
      // widen the policy to a wildcard or produce a source the browser
      // silently ignores, and a silently ignored source means broken tiles
      // with no error.
      expect(() =>
        loadConfig({
          ...envFor(),
          MAP_TILE_URL: 'https://{s}.tile.example.org/{z}/{x}/{y}.png',
          MAP_TILE_ATTRIBUTION: '© Example',
        }),
      ).toThrow(/MAP_TILE_URL/);
    });

    it('refuses a URL that is not a tile template', () => {
      expect(() =>
        loadConfig({
          ...envFor(),
          MAP_TILE_URL: 'https://tiles.example.org/static.png',
          MAP_TILE_ATTRIBUTION: '© Example',
        }),
      ).toThrow(/MAP_TILE_URL/);
    });

    it('requires attribution alongside a tile URL', () => {
      expect(() =>
        loadConfig({
          ...envFor(),
          MAP_TILE_URL: 'https://tiles.example.org/{z}/{x}/{y}.png',
        }),
      ).toThrow(/MAP_TILE_ATTRIBUTION/);
    });
  });

  describe('geocoding', () => {
    async function jobs(): Promise<RowDataPacket[]> {
      return queryRows<RowDataPacket>(
        harness.pool,
        `SELECT kind, payload FROM job WHERE kind = 'place.geocode'`,
      );
    }

    it('queues a job carrying the key the worker reads', async () => {
      const id = await place('Iasi', 'public');
      const outcome = await requestGeocode(harness.pool, id);
      expect(outcome).toBe('queued');

      const queued = await jobs();
      expect(queued).toHaveLength(1);
      const payload = queued[0]?.payload as { contentItemId?: number };
      // geocode.py raises on anything but contentItemId, and a wrong key here
      // would retry forever rather than fail visibly.
      expect(payload.contentItemId).toBe(id);
    });

    it('does not queue a second lookup while one is pending', async () => {
      const id = await place('Iasi', 'public');
      await requestGeocode(harness.pool, id);
      expect(await requestGeocode(harness.pool, id)).toBe('already_queued');
      expect(await jobs()).toHaveLength(1);
    });

    it('queues separately for a different place', async () => {
      const first = await place('Iasi', 'public');
      const second = await place('Chisinau', 'public');
      await requestGeocode(harness.pool, first);
      expect(await requestGeocode(harness.pool, second)).toBe('queued');
      expect(await jobs()).toHaveLength(2);
    });

    it('refuses a nonsense id rather than queueing it', async () => {
      await expect(requestGeocode(harness.pool, 0)).rejects.toThrow(TypeError);
      await expect(requestGeocode(harness.pool, -3)).rejects.toThrow(TypeError);
      expect(await jobs()).toHaveLength(0);
    });

    it('is reachable only by an administrator', async () => {
      const id = await place('Iasi', 'public');
      const anonymous = await harness.app.inject({
        method: 'POST',
        url: `/admin/places/${id}/geocode`,
      });
      expect(anonymous.statusCode).toBe(302);
      expect(await jobs()).toHaveLength(0);
    });
  });
});

/** A complete environment, so `loadConfig` exercises the real schema. */
function envFor(): Record<string, string> {
  const base = testConfig();
  return {
    NODE_ENV: 'test',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '8080',
    PUBLIC_BASE_URL: base.PUBLIC_BASE_URL,
    DB_HOST: base.DB_HOST,
    DB_PORT: String(base.DB_PORT),
    DB_NAME: base.DB_NAME,
    DB_USER: base.DB_USER,
    DB_PASSWORD: base.DB_PASSWORD,
    WEBAUTHN_RP_ID: base.WEBAUTHN_RP_ID,
    WEBAUTHN_ORIGIN: base.WEBAUTHN_ORIGINS.join(','),
    STORAGE_ROOT: base.STORAGE_ROOT,
  };
}
