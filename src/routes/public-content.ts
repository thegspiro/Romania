/**
 * Public pages for entities, essays, artifacts and manuscripts.
 *
 * Every handler passes `request.viewer` into the repository, so an
 * administrator browsing the public side sees their private material too --
 * marked as such -- while everyone else sees only what has been published.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { notFound } from '../http/errors.js';
import {
  ENTITY_KINDS,
  ENTITY_LABELS,
  findEntityBySlug,
  listEntities,
} from '../content/entities.js';
import { KIND_PATHS } from '../content/references.js';
import { findEssayBySlug, listEssays } from '../content/essays.js';
import { findArtifactBySlug, listArtifacts } from '../content/artifacts.js';
import {
  findManuscriptBySlug,
  listManuscripts,
  listSections,
  navigationFor,
} from '../content/manuscripts.js';
import { listMentionsOf, listMentionsFrom } from '../content/mentions.js';
import { listRelationshipsFor } from '../content/relationships.js';
import { buildGraph, indirectConnections, parseGraphYear } from '../content/graph.js';
import { renderProse, renderFragment } from '../content/markdown.js';
import { resolveForRender, resolveTimelines } from '../content/render-context.js';
import {
  findTimelineEntry,
  groupEntries,
  layoutTimelineBand,
  listEventsAround,
  listEventsMentionedBy,
  listEventsRelatedTo,
} from '../content/timeline.js';
import { findServableFile } from '../files/repository.js';
import { resolveStoragePath } from '../files/storage.js';
import { findMappablePlace } from '../content/places.js';
import { parseSlug } from './form.js';

export function registerPublicContentRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  // --- Entities ------------------------------------------------------------

  for (const kind of ENTITY_KINDS) {
    const path = KIND_PATHS[kind]!;
    const labels = ENTITY_LABELS[kind];

    app.get(`/${path}`, async (request, reply) => {
      const query = request.query as { q?: string; page?: string };
      const pageNumber = Math.max(Number(query.page ?? '1') || 1, 1);
      const perPage = 50;

      const result = await listEntities(pool, kind, request.viewer, {
        search: query.q,
        limit: perPage,
        offset: (pageNumber - 1) * perPage,
      });

      return renderPage(config, request, reply, 'entities/index', {
        kind,
        path,
        labels,
        items: result.items,
        total: result.total,
        page: pageNumber,
        pageCount: Math.max(Math.ceil(result.total / perPage), 1),
        search: query.q ?? '',
      });
    });

    app.get(`/${path}/:slug`, async (request, reply) => {
      const slug = parseSlug(request);
      const record = await findEntityBySlug(pool, kind, slug, request.viewer);
      if (record === null) throw notFound(`${kind} ${slug}`);

      // The kind's own prose -- a person's biography, an event's narrative.
      // Rendered through `renderProse` rather than `renderFragment` so its
      // references link and its paragraphs carry the anchors a backlink
      // addresses, exactly as an essay's do.
      const body = record.detail.bodyMarkdown ?? record.detail.biography;
      const rendered =
        typeof body === 'string' && body.trim() !== ''
          ? renderProse(body, {
              targets: await resolveForRender(pool, body, request.viewer),
              viewer: request.viewer,
              timelines: await resolveTimelines(pool, body, request.viewer),
            })
          : null;

      // Where this subject sits in time: the events it is connected to, by
      // asserted edge or by prose, in date order.
      const chronology = await listEventsRelatedTo(pool, record.id, request.viewer);

      // The event's own date label and place, resolved by the same read that
      // resolves them for every listing -- so a private place is withheld here
      // for the same reason and in the same way.
      const event = kind === 'event' ? await findTimelineEntry(pool, slug, request.viewer) : null;

      // ...and what else was going on around it, over a window that widens with
      // how coarsely the event itself is dated.
      const around = event === null ? [] : await listEventsAround(pool, event, request.viewer);

      // A place with coordinates carries a single marker. The read is filtered
      // like any other, so this is null for a place the viewer may not see --
      // which cannot happen here, since `findEntityBySlug` already 404ed, but
      // the point is that the map never learns anything the page did not.
      const point =
        kind === 'place' ? await findMappablePlace(pool, request.viewer, record.id) : null;

      // Re-parsed rather than echoed, so nothing from the query string reaches
      // the page unchecked. The same year narrows the text below and the
      // drawing's data URL, so the two cannot disagree about which network is
      // being shown.
      const graphYear = parseGraphYear((request.query as { year?: unknown }).year);

      // Two hops out, as text. The drawing is the same walk, so the page is
      // complete without JavaScript rather than complete only for a reader who
      // can run it -- and the list can be searched in the page and printed.
      // `indirectConnections` adds no query and makes no visibility decision:
      // this graph is already filtered at every hop.
      const graph = await buildGraph(
        pool,
        { id: record.id, kind: record.kind, slug: record.slug, title: record.title },
        request.viewer,
        2,
        { year: graphYear },
      );

      return renderPage(
        config,
        request,
        reply,
        'entities/show',
        {
          kind,
          path,
          labels,
          record,
          summaryHtml: record.summary === null ? null : renderFragment(record.summary),
          rendered,
          event,
          chronology,
          chronologyBand: layoutTimelineBand(chronology),
          chronologyGroups: groupEntries(chronology),
          around,
          aroundBand: layoutTimelineBand(around),
          aroundGroups: groupEntries(around),
          // "the other places that they have been mentioned"
          mentions: await listMentionsOf(pool, record.id, request.viewer),
          relationships: await listRelationshipsFor(pool, record.id, request.viewer),
          // Not directly connected, but connected: the item in the middle and
          // the hop on either side of it.
          connected: indirectConnections(graph),
          // The walk ran out of budget before it ran out of neighbours, so the
          // count above is of what was reached rather than of what there is.
          graphTruncated: graph.truncated,
          // Carried into the graph's data URL so the year survives a reload
          // without JavaScript.
          graphYear,
          point,
          mapTileUrl: config.MAP_TILE_URL ?? '',
          mapTileAttribution: config.MAP_TILE_ATTRIBUTION ?? '',
          canonicalUrl: `${config.PUBLIC_BASE_URL}${record.href}`,
        },
        { noindex: record.noindex || record.visibility !== 'public' },
      );
    });
  }

  // --- Essays --------------------------------------------------------------

  app.get('/essays', async (request, reply) => {
    const query = request.query as { q?: string; page?: string };
    const pageNumber = Math.max(Number(query.page ?? '1') || 1, 1);
    const perPage = 50;

    const result = await listEssays(pool, request.viewer, {
      search: query.q,
      limit: perPage,
      offset: (pageNumber - 1) * perPage,
    });

    return renderPage(config, request, reply, 'essays/index', {
      essays: result.items,
      total: result.total,
      page: pageNumber,
      pageCount: Math.max(Math.ceil(result.total / perPage), 1),
      search: query.q ?? '',
    });
  });

  app.get('/essays/:slug', async (request, reply) => {
    const slug = parseSlug(request);
    const essay = await findEssayBySlug(pool, slug, request.viewer);
    if (essay === null) throw notFound(`essay ${slug}`);

    const targets = await resolveForRender(pool, essay.bodyMarkdown, request.viewer);
    const rendered = renderProse(essay.bodyMarkdown, {
      targets,
      viewer: request.viewer,
      timelines: await resolveTimelines(pool, essay.bodyMarkdown, request.viewer),
    });

    // Where this piece sits in the whole, when it is part of one.
    const chronology = await listEventsMentionedBy(pool, essay.id, request.viewer);

    const manuscriptSlug = (request.query as { manuscript?: string }).manuscript;
    let navigation = null;
    if (typeof manuscriptSlug === 'string' && /^[a-z0-9-]{1,190}$/.test(manuscriptSlug)) {
      const manuscript = await findManuscriptBySlug(pool, manuscriptSlug, request.viewer);
      if (manuscript !== null) {
        navigation = await navigationFor(pool, manuscript.id, essay.id, request.viewer);
      }
    }

    return renderPage(
      config,
      request,
      reply,
      'essays/show',
      {
        essay,
        rendered,
        navigation,
        mentions: await listMentionsFrom(pool, essay.id, request.viewer),
        mentionedIn: await listMentionsOf(pool, essay.id, request.viewer),
        // The events this piece names, read as a sequence rather than as an
        // alphabetical list of links.
        chronology,
        chronologyBand: layoutTimelineBand(chronology),
        chronologyGroups: groupEntries(chronology),
        canonicalUrl: `${config.PUBLIC_BASE_URL}${essay.href}`,
      },
      { noindex: essay.noindex || essay.visibility !== 'public' },
    );
  });

  // --- Artifacts -----------------------------------------------------------

  app.get('/artifacts', async (request, reply) => {
    const query = request.query as { q?: string; page?: string };
    const pageNumber = Math.max(Number(query.page ?? '1') || 1, 1);
    const perPage = 50;

    const result = await listArtifacts(pool, request.viewer, {
      search: query.q,
      limit: perPage,
      offset: (pageNumber - 1) * perPage,
    });

    return renderPage(config, request, reply, 'artifacts/index', {
      artifacts: result.items,
      total: result.total,
      page: pageNumber,
      pageCount: Math.max(Math.ceil(result.total / perPage), 1),
      search: query.q ?? '',
    });
  });

  app.get('/artifacts/:slug', async (request, reply) => {
    const slug = parseSlug(request);
    const artifact = await findArtifactBySlug(pool, slug, request.viewer);
    if (artifact === null) throw notFound(`artifact ${slug}`);

    return renderPage(
      config,
      request,
      reply,
      'artifacts/show',
      {
        artifact,
        summaryHtml: artifact.summary === null ? null : renderFragment(artifact.summary),
        // The transcription is prose, so it renders through the same pipeline
        // an essay body does -- which is what makes a reference inside it a
        // link the viewer may follow, or escaped plain text when they may not.
        transcriptionHtml:
          artifact.transcription === null || artifact.transcription.trim() === ''
            ? null
            : renderProse(artifact.transcription, {
                targets: await resolveForRender(pool, artifact.transcription, request.viewer),
                viewer: request.viewer,
              }).html,
        mentions: await listMentionsOf(pool, artifact.id, request.viewer),
        // An artifact is an end of a typed edge like any other item -- it is
        // depicted, and it was created by someone. Read with the same filter,
        // so the edge and both of its ends must be visible.
        relationships: await listRelationshipsFor(pool, artifact.id, request.viewer),
        canonicalUrl: `${config.PUBLIC_BASE_URL}${artifact.href}`,
      },
      { noindex: artifact.noindex || artifact.visibility !== 'public' },
    );
  });

  // --- Manuscripts ---------------------------------------------------------

  app.get('/manuscripts', async (request, reply) => {
    return renderPage(config, request, reply, 'manuscripts/index', {
      manuscripts: await listManuscripts(pool, request.viewer),
    });
  });

  /**
   * The table of contents: the whole, shown as its pieces.
   *
   * Private sections are omitted entirely -- no placeholder, no gap in the
   * numbering. A "section withheld" marker would disclose that it exists.
   */
  app.get('/manuscripts/:slug', async (request, reply) => {
    const slug = parseSlug(request);
    const manuscript = await findManuscriptBySlug(pool, slug, request.viewer);
    if (manuscript === null) throw notFound(`manuscript ${slug}`);

    const sections = await listSections(pool, manuscript.id, request.viewer);

    return renderPage(
      config,
      request,
      reply,
      'manuscripts/show',
      {
        manuscript,
        sections,
        abstractHtml:
          manuscript.abstractMarkdown === null ? null : renderFragment(manuscript.abstractMarkdown),
        wordCount: sections.reduce((total, section) => total + section.wordCount, 0),
        canonicalUrl: `${config.PUBLIC_BASE_URL}${manuscript.href}`,
      },
      { noindex: manuscript.noindex || manuscript.visibility !== 'public' },
    );
  });

  // --- Files ---------------------------------------------------------------

  /**
   * Serves file bytes.
   *
   * Invariant 3: the owning item's visibility is re-checked on every request.
   * Every failure -- unknown id, unknown variant, private owner, no owning
   * artifact -- answers 404, so the response never distinguishes "does not
   * exist" from "not yours".
   */
  app.get('/files/:id/:variant', async (request, reply) => {
    const parameters = request.params as { id?: string; variant?: string };
    const id = Number(parameters.id);
    const variant = parameters.variant ?? '';

    if (!Number.isSafeInteger(id) || id <= 0) throw notFound('invalid file id');
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(variant)) throw notFound('invalid variant');

    const file = await findServableFile(pool, id, variant, request.viewer);
    if (file === null) throw notFound(`file ${id}/${variant}`);

    const path = resolveStoragePath(config.STORAGE_ROOT, file.storageKey);
    try {
      await stat(path);
    } catch {
      throw notFound(`file ${id} is missing from storage`);
    }

    return (
      reply
        .type(file.mimeType)
        .header('Content-Length', String(file.byteSize))
        .header('ETag', `"${file.sha256}"`)
        // Private files must not be held in a shared cache; the header is set
        // uniformly so a file's cacheability never reveals its visibility.
        .header('Cache-Control', 'private, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff')
        // An uploaded SVG or HTML would otherwise execute in this origin.
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(createReadStream(path))
    );
  });

  // --- Graph ---------------------------------------------------------------

  /**
   * Nodes and edges around one item, for the network view.
   *
   * Visibility-filtered at every hop: a private node is not merely hidden from
   * the drawing, it is never traversed through, so the shape of the graph
   * cannot betray one sitting between two public nodes.
   */
  app.get('/graph/:kind/:slug.json', async (request, reply) => {
    const parameters = request.params as { kind?: string; slug?: string };
    const kind = parameters.kind ?? '';
    const slug = (parameters.slug ?? '').replace(/\.json$/, '');

    if (!/^[a-z0-9-]{1,190}$/.test(slug)) throw notFound('invalid slug');

    const entityKind = ENTITY_KINDS.find((candidate) => KIND_PATHS[candidate] === kind);
    if (entityKind === undefined) throw notFound(`unknown kind ${kind}`);

    const record = await findEntityBySlug(pool, entityKind, slug, request.viewer);
    if (record === null) throw notFound(`${entityKind} ${slug}`);

    const query = request.query as { depth?: string; year?: unknown };
    const depth = Number(query.depth ?? '2');
    const graph = await buildGraph(
      pool,
      { id: record.id, kind: record.kind, slug: record.slug, title: record.title },
      request.viewer,
      Number.isSafeInteger(depth) ? depth : 2,
      // A year narrows which asserted edges are drawn. It is not a visibility
      // decision and cannot become one: the filter is ANDed on top of the
      // viewer's own, never in place of it.
      { year: parseGraphYear(query.year) },
    );

    return reply.type('application/json').header('Cache-Control', 'private, no-store').send(graph);
  });
}
