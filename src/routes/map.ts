/**
 * The gazetteer as a map.
 *
 * Public, like the place pages it summarises: it shows exactly the places a
 * visitor could already reach one at a time, with their coordinates, which
 * those pages already print. Nothing becomes visible here that was not
 * visible before -- `listMappablePlaces` applies `visibilityFilter`, so a
 * private place is simply not in the set, leaving no gap to notice.
 *
 * The JSON endpoint exists for the same reason `/graph/:kind/:slug.json`
 * does: the drawing happens in the browser, and the server hands it data it
 * has already filtered rather than letting a script ask for anything.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { listMappablePlaces, MAX_MAP_POINTS } from '../content/places.js';

export function registerMapRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  app.get('/map', async (request, reply) => {
    const { places, total } = await listMappablePlaces(pool, request.viewer);

    return renderPage(config, request, reply, 'map/index', {
      places,
      total,
      // The list under the map is the same set, so saying how many were left
      // out is honest rather than alarming: it is a ceiling on drawing, not a
      // visibility decision.
      truncated: total > places.length,
      maxPoints: MAX_MAP_POINTS,
      mapTileUrl: config.MAP_TILE_URL ?? '',
      mapTileAttribution: config.MAP_TILE_ATTRIBUTION ?? '',
    });
  });

  app.get('/map/places.json', async (request, reply) => {
    const { places, total } = await listMappablePlaces(pool, request.viewer);

    // Same rule as a place page: never cached by a shared proxy, because what
    // comes back depends on who asked.
    reply.header('Cache-Control', 'no-store');
    return reply.send({ places, total });
  });
}
