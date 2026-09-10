/**
 * The chronology page.
 *
 * A timeline is a listing, which makes it the shape of thing that leaks: it
 * puts many items on one page, so a single missing filter would disclose
 * everything at once rather than one item. Nothing here decides visibility --
 * `listTimeline` applies the chokepoint, and this handler only validates the
 * filters it is given.
 *
 * In particular there is no `visibility` filter honoured from the query string.
 * `listEntities` refuses one for the same reason: `?visibility=private` would
 * turn the page into an enumeration tool.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { ENTITY_KINDS, ENTITY_LABELS } from '../content/entities.js';
import { KIND_PATHS } from '../content/references.js';
import { layoutTimelineBand, listTimeline } from '../content/timeline.js';

const PER_PAGE = 50;

/** A year or an ISO date, or nothing. Anything else is ignored, not rejected. */
function boundary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^\d{4}$/.test(trimmed) || /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function slug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[a-z0-9-]{1,190}$/.test(trimmed) ? trimmed : undefined;
}

/** `person:ion-antonescu` -- the same vocabulary the reference picker writes. */
function related(value: unknown): { kind: string; slug: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const separator = value.indexOf(':');
  if (separator === -1) return undefined;

  const kind = value.slice(0, separator).trim();
  const target = slug(value.slice(separator + 1));
  if (target === undefined) return undefined;
  if (!(ENTITY_KINDS as readonly string[]).includes(kind)) return undefined;

  return { kind, slug: target };
}

export function registerTimelineRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  app.get('/timeline', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const pageNumber = Math.max(Number(query.page ?? '1') || 1, 1);

    const search = typeof query.q === 'string' ? query.q : '';
    const from = boundary(query.from);
    const to = boundary(query.to);
    const place = slug(query.place);
    const subject = related(query.related);

    const result = await listTimeline(pool, request.viewer, {
      search,
      from,
      to,
      placeSlug: place,
      relatedKind: subject?.kind,
      relatedSlug: subject?.slug,
      limit: PER_PAGE,
      offset: (pageNumber - 1) * PER_PAGE,
    });

    return renderPage(config, request, reply, 'timeline/index', {
      entries: result.items,
      // The drawing is built from the page being shown, so it always agrees
      // with the list beneath it.
      band: layoutTimelineBand(result.items),
      total: result.total,
      page: pageNumber,
      pageCount: Math.max(Math.ceil(result.total / PER_PAGE), 1),
      search,
      from: from ?? '',
      to: to ?? '',
      place: place ?? '',
      related: subject === undefined ? '' : `${subject.kind}:${subject.slug}`,
      entityKinds: ENTITY_KINDS.map((kind) => ({
        kind,
        label: ENTITY_LABELS[kind].singular,
        path: KIND_PATHS[kind] ?? kind,
      })),
    });
  });
}
