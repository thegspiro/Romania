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
import { buildGraph } from '../content/graph.js';
import { renderProse, renderFragment } from '../content/markdown.js';
import { resolveForRender } from '../content/render-context.js';
import { findServableFile } from '../files/repository.js';
import { resolveStoragePath } from '../files/storage.js';
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
          biographyHtml:
            typeof record.detail.biography === 'string' && record.detail.biography !== ''
              ? renderFragment(record.detail.biography)
              : null,
          // "the other places that they have been mentioned"
          mentions: await listMentionsOf(pool, record.id, request.viewer),
          relationships: await listRelationshipsFor(pool, record.id, request.viewer),
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
    const rendered = renderProse(essay.bodyMarkdown, { targets, viewer: request.viewer });

    // Where this piece sits in the whole, when it is part of one.
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
        mentions: await listMentionsOf(pool, artifact.id, request.viewer),
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

    const depth = Number((request.query as { depth?: string }).depth ?? '2');
    const graph = await buildGraph(
      pool,
      { id: record.id, kind: record.kind, slug: record.slug, title: record.title },
      request.viewer,
      Number.isSafeInteger(depth) ? depth : 2,
    );

    return reply.type('application/json').header('Cache-Control', 'private, no-store').send(graph);
  });
}
