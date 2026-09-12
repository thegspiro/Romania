/**
 * The corpus-wide search page.
 *
 * Registered inside the admin scope, so it inherits the guard there and no
 * check is repeated in the handler. `searchCorpus` still takes the request's
 * `Viewer` and still applies `visibilityFilter`: the filter resolves to
 * `1 = 1` for an administrator, and writing the call any other way would leave
 * a read that could not be moved out from behind the guard safely.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { filterQuery } from './form.js';
import { KIND_PATHS } from '../content/references.js';
import { isSearchKind, searchCorpus, SEARCH_KINDS, type SearchKind } from '../content/search.js';

const PER_PAGE = 20;

/** Plural labels for the kind filter, in the order the admin nav uses. */
const KIND_LABELS: Readonly<Record<SearchKind, string>> = Object.freeze({
  essay: 'Essays',
  source: 'Sources',
  artifact: 'Artifacts',
  person: 'People',
  organization: 'Organizations',
  place: 'Places',
  event: 'Events',
});

export function registerAdminSearchRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  app.get('/admin/search', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const raw = query.q ?? '';
    const kind = isSearchKind(query.kind) ? query.kind : undefined;

    const requested = Number.parseInt(query.page ?? '1', 10);
    const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;

    const { hits, total, words } = await searchCorpus(pool, request.viewer, raw, {
      kind,
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    });

    return renderPage(
      config,
      request,
      reply,
      'admin/search',
      {
        search: raw,
        words,
        searched: words.length > 0,
        kind: kind ?? '',
        kinds: SEARCH_KINDS.map((value) => ({ value, label: KIND_LABELS[value] })),
        results: hits.map((hit) => ({
          ...hit,
          label: KIND_LABELS[hit.kind],
          // Every kind's editor lives at /admin/<plural>/:id/edit, and the
          // plural is the one already used for public URLs and references.
          href: `/admin/${KIND_PATHS[hit.kind] ?? ''}/${hit.id}/edit`,
        })),
        total,
        page,
        pageCount: Math.max(1, Math.ceil(total / PER_PAGE)),
        filterQuery: filterQuery({ q: raw, kind }),
      },
      // A results page is a list of fragments from across the corpus, most of
      // it unpublished. It must never be indexed, whatever the site setting.
      { noindex: true },
    );
  });
}
