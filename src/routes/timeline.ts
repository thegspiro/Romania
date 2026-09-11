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
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { applyIndexingHeader } from '../http/security.js';
import { ENTITY_KINDS, ENTITY_LABELS } from '../content/entities.js';
import { KIND_PATHS } from '../content/references.js';
import {
  groupEntries,
  isCalendarDate,
  layoutTimelineBand,
  listTimeline,
} from '../content/timeline.js';
import { toCsv, toICalendar } from '../content/timeline-export.js';
import type { Pool } from '../db/pool.js';
import type { Viewer } from '../content/visibility.js';
import type { TimelineEntry } from '../content/timeline.js';
import { filterQuery } from './form.js';

const PER_PAGE = 50;

/**
 * How much of a chronology an export will carry.
 *
 * `listTimeline` caps a single read at 200 rows, so an export pages through it.
 * The ceiling is a bound on the work one request can ask of the database, not a
 * judgement about the material: the export links carry the page's own filters,
 * so a larger chronology is narrowed rather than truncated.
 */
const EXPORT_PAGE = 200;
const EXPORT_MAX = 2000;

/** A year or an ISO date, or nothing. Anything else is ignored, not rejected. */
function boundary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^\d{4}$/.test(trimmed)) return trimmed;
  // A real calendar date, not merely the shape of one: `1940-13-45` matches the
  // pattern and would otherwise reach a MySQL DATE comparison.
  return isCalendarDate(trimmed) ? trimmed : undefined;
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

/** The filters `/timeline` honours -- and, unchanged, the two exports. */
interface TimelineQuery {
  search: string;
  from: string | undefined;
  to: string | undefined;
  place: string | undefined;
  subject: { kind: string; slug: string } | undefined;
}

/**
 * Reads the filters out of a query string.
 *
 * Shared by the page and by both exports, so an export can honour exactly what
 * the page honours -- and, more to the point, refuse exactly what it refuses.
 * There is no `visibility` here for either.
 */
function parseTimelineQuery(query: Record<string, unknown>): TimelineQuery {
  return {
    search: typeof query.q === 'string' ? query.q : '',
    from: boundary(query.from),
    to: boundary(query.to),
    place: slug(query.place),
    subject: related(query.related),
  };
}

function filtersFor(parsed: TimelineQuery) {
  return {
    search: parsed.search,
    from: parsed.from,
    to: parsed.to,
    placeSlug: parsed.place,
    relatedKind: parsed.subject?.kind,
    relatedSlug: parsed.subject?.slug,
  };
}

/** Pages through `listTimeline` so an export is not capped at one page. */
async function collectForExport(
  pool: Pool,
  viewer: Viewer,
  parsed: TimelineQuery,
): Promise<TimelineEntry[]> {
  const items: TimelineEntry[] = [];
  for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_PAGE) {
    const result = await listTimeline(pool, viewer, {
      ...filtersFor(parsed),
      limit: EXPORT_PAGE,
      offset,
    });
    items.push(...result.items);
    if (result.items.length < EXPORT_PAGE) break;
  }
  return items.slice(0, EXPORT_MAX);
}

/**
 * A downloaded file, never a cached one.
 *
 * `no-store` because a chronology an administrator exported may hold
 * unpublished material, and a shared cache must not keep a copy of it.
 */
function sendDownload(
  config: AppContext['config'],
  reply: FastifyReply,
  type: string,
  filename: string,
  body: string,
): void {
  // An export is a listing like the page it came from, so it carries the same
  // crawler policy. Nothing else on this route reaches `renderPage`, which is
  // where every other page picks the header up.
  applyIndexingHeader(config, reply);
  void reply
    .type(`${type}; charset=utf-8`)
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .header('Cache-Control', 'private, no-store')
    .send(body);
}

export function registerTimelineRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  app.get('/timeline.csv', async (request, reply) => {
    const parsed = parseTimelineQuery(request.query as Record<string, unknown>);
    const items = await collectForExport(pool, request.viewer, parsed);
    sendDownload(config, reply, 'text/csv', 'timeline.csv', toCsv(items, config.PUBLIC_BASE_URL));
    return reply;
  });

  app.get('/timeline.ics', async (request, reply) => {
    const parsed = parseTimelineQuery(request.query as Record<string, unknown>);
    const items = await collectForExport(pool, request.viewer, parsed);
    sendDownload(
      config,
      reply,
      'text/calendar',
      'timeline.ics',
      toICalendar(items, config.PUBLIC_BASE_URL),
    );
    return reply;
  });

  app.get('/timeline', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const pageNumber = Math.max(Number(query.page ?? '1') || 1, 1);

    const parsed = parseTimelineQuery(query);
    const { search, from, to, place, subject } = parsed;

    const result = await listTimeline(pool, request.viewer, {
      ...filtersFor(parsed),
      limit: PER_PAGE,
      offset: (pageNumber - 1) * PER_PAGE,
    });

    return renderPage(config, request, reply, 'timeline/index', {
      entries: result.items,
      // The drawing is built from the page being shown, so it always agrees
      // with the list beneath it.
      band: layoutTimelineBand(result.items),
      // Headings over the same rows, cut no finer than the coarsest precision
      // any of them carries.
      groups: groupEntries(result.items),
      total: result.total,
      page: pageNumber,
      pageCount: Math.max(Math.ceil(result.total / PER_PAGE), 1),
      search,
      from: from ?? '',
      to: to ?? '',
      place: place ?? '',
      related: subject === undefined ? '' : `${subject.kind}:${subject.slug}`,
      // Everything a paging link must repeat. Built from the validated values,
      // not echoed from the query string, so nothing unchecked reaches the
      // href -- and so page 2 of a filtered chronology is still filtered.
      filterQuery: filterQuery({
        q: search,
        from,
        to,
        place,
        related: subject === undefined ? undefined : `${subject.kind}:${subject.slug}`,
      }),
      entityKinds: ENTITY_KINDS.map((kind) => ({
        kind,
        label: ENTITY_LABELS[kind].singular,
        path: KIND_PATHS[kind] ?? kind,
      })),
    });
  });
}
