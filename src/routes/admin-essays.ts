/**
 * Admin routes for essays: the editor, the reference picker and the preview.
 *
 * The preview renders through the same pipeline the published page uses, so
 * what the operator checks is what visitors get -- including citations and
 * how a reference to something still private will appear.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { badRequest, notFound } from '../http/errors.js';
import { isVisibility } from '../content/visibility.js';
import {
  ESSAY_STATUSES,
  createEssay,
  deleteEssay,
  findEssayById,
  isEssayStatus,
  listEssays,
  setEssayVisibility,
  updateEssay,
  type EssayInput,
} from '../content/essays.js';
import { renderProse } from '../content/markdown.js';
import {
  parseReferences,
  referenceKey,
  targetKind,
  REFERENCE_KINDS,
} from '../content/references.js';
import { resolveForRender, resolveTimelines } from '../content/render-context.js';
import { searchAllEntities } from '../content/entities.js';
import { listPlacementsOf } from '../content/manuscripts.js';
import { recordAudit } from '../content/audit.js';
import { actorId, flashFor, parseId, readCheckbox, readString } from './form.js';

function readEssayForm(body: unknown): { input: EssayInput; errors: string[] } {
  const errors: string[] = [];

  const title = readString(body, 'title').trim();
  if (title === '') errors.push('A title is required.');
  if (title.length > 500) errors.push('The title is too long (500 characters maximum).');

  const statusRaw = readString(body, 'status') || 'draft';
  if (!isEssayStatus(statusRaw)) errors.push('Choose a status.');

  const visibilityRaw = readString(body, 'visibility') || 'private';

  return {
    input: {
      title,
      titleOriginal: readString(body, 'titleOriginal'),
      language: readString(body, 'language'),
      summary: readString(body, 'summary'),
      visibility: isVisibility(visibilityRaw) ? visibilityRaw : 'private',
      noindex: readCheckbox(body, 'noindex'),
      bodyMarkdown: readString(body, 'bodyMarkdown'),
      status: isEssayStatus(statusRaw) ? statusRaw : 'draft',
    },
    errors,
  };
}

export function registerAdminEssayRoutes(admin: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  admin.get('/admin/essays', async (request, reply) => {
    const query = request.query as { q?: string; visibility?: string; page?: string };
    const pageNumber = Math.max(Number(query.page ?? '1') || 1, 1);
    const perPage = 25;
    const visibility = isVisibility(query.visibility) ? query.visibility : undefined;

    const result = await listEssays(pool, request.viewer, {
      search: query.q,
      visibility,
      limit: perPage,
      offset: (pageNumber - 1) * perPage,
    });

    return renderPage(
      config,
      request,
      reply,
      'admin/essays/index',
      {
        essays: result.items,
        total: result.total,
        page: pageNumber,
        pageCount: Math.max(Math.ceil(result.total / perPage), 1),
        search: query.q ?? '',
        visibilityFilter: visibility ?? '',
      },
      { noindex: true, flash: flashFor(request) },
    );
  });

  admin.get('/admin/essays/new', async (request, reply) => {
    return renderPage(
      config,
      request,
      reply,
      'admin/essays/form',
      {
        mode: 'create',
        action: '/admin/essays',
        statuses: ESSAY_STATUSES,
        values: { visibility: 'private', status: 'draft', noindex: false },
        errors: [],
      },
      { noindex: true },
    );
  });

  admin.post('/admin/essays', async (request, reply) => {
    const { input, errors } = readEssayForm(request.body);
    if (errors.length > 0) {
      return renderPage(
        config,
        request,
        reply,
        'admin/essays/form',
        {
          mode: 'create',
          action: '/admin/essays',
          statuses: ESSAY_STATUSES,
          values: input,
          errors,
        },
        { status: 400, noindex: true },
      );
    }

    const result = await createEssay(pool, input);
    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.create',
        itemId: result.id,
        detail: { kind: 'essay', title: input.title, mentions: result.references.mentions },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect(`/admin/essays/${result.id}/edit?msg=essay_created`);
  });

  admin.get('/admin/essays/:id/edit', async (request, reply) => {
    const id = parseId(request);
    const essay = await findEssayById(pool, id, request.viewer);
    if (essay === null) throw notFound(`essay ${id}`);

    const targets = await resolveForRender(pool, essay.bodyMarkdown, request.viewer);
    const references = parseReferences(essay.bodyMarkdown);

    // Warn about references that point at nothing, and about citations to
    // sources that are still private -- both would surprise the operator
    // after publishing, when it is too late to notice quietly.
    const unresolved = references
      .filter((reference) => !targets.has(referenceKey(reference.kind, reference.slug)))
      .map((reference) => `${targetKind(reference.kind)}:${reference.slug}`);

    const privateCitations = references
      .filter((reference) => reference.kind === 'cite')
      .map((reference) => targets.get(referenceKey(reference.kind, reference.slug)))
      .filter((target) => target !== undefined && target.visible === false)
      .map((target) => target!.title);

    return renderPage(
      config,
      request,
      reply,
      'admin/essays/form',
      {
        mode: 'edit',
        action: `/admin/essays/${id}`,
        essay,
        statuses: ESSAY_STATUSES,
        values: essay,
        errors: [],
        unresolved: [...new Set(unresolved)],
        privateCitations: [...new Set(privateCitations)],
        placements: await listPlacementsOf(pool, id, request.viewer),
      },
      { noindex: true, flash: flashFor(request) },
    );
  });

  admin.post('/admin/essays/:id', async (request, reply) => {
    const id = parseId(request);
    const { input, errors } = readEssayForm(request.body);

    if (errors.length > 0) {
      const essay = await findEssayById(pool, id, request.viewer);
      if (essay === null) throw notFound(`essay ${id}`);
      return renderPage(
        config,
        request,
        reply,
        'admin/essays/form',
        {
          mode: 'edit',
          action: `/admin/essays/${id}`,
          essay,
          statuses: ESSAY_STATUSES,
          values: input,
          errors,
        },
        { status: 400, noindex: true },
      );
    }

    const result = await updateEssay(pool, id, input);
    if (result === null) throw notFound(`essay ${id}`);

    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.update',
        itemId: id,
        detail: {
          kind: 'essay',
          mentions: result.references.mentions,
          citations: result.references.citations,
        },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect(`/admin/essays/${id}/edit?msg=essay_updated`);
  });

  admin.post('/admin/essays/:id/visibility', async (request, reply) => {
    const id = parseId(request);
    const requested = readString(request.body, 'visibility');
    if (!isVisibility(requested)) throw badRequest('Unknown visibility value.');

    if (!(await setEssayVisibility(pool, id, requested))) throw notFound(`essay ${id}`);
    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: requested === 'public' ? 'source.publish' : 'source.unpublish',
        itemId: id,
        detail: { kind: 'essay' },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect(
      `/admin/essays?msg=${requested === 'public' ? 'entity_published' : 'entity_unpublished'}`,
    );
  });

  admin.post('/admin/essays/:id/delete', async (request, reply) => {
    const id = parseId(request);
    const outcome = await deleteEssay(pool, id);

    if (outcome === 'not_found') throw notFound(`essay ${id}`);
    if (outcome === 'referenced')
      return reply.redirect(`/admin/essays/${id}/edit?msg=entity_referenced`);

    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.delete',
        itemId: id,
        detail: { kind: 'essay' },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect('/admin/essays?msg=essay_deleted');
  });

  // --- Editor support ------------------------------------------------------

  /**
   * Type-ahead for the reference picker.
   *
   * Returns the reference text to insert, so the client never has to know how
   * the syntax is spelled -- one definition, in `formatReference`.
   */
  admin.get('/admin/reference-search', async (request, reply) => {
    const query = request.query as { q?: string; kind?: string };
    const term = (query.q ?? '').trim();
    const requested = (query.kind ?? '').trim();

    const kinds =
      requested === '' || requested === 'all'
        ? ['person', 'organization', 'place', 'event', 'artifact', 'source', 'essay']
        : REFERENCE_KINDS.includes(requested as never)
          ? [targetKind(requested as never)]
          : [];

    const results = await searchAllEntities(pool, request.viewer, term, kinds, 20);

    return reply.type('application/json').send({
      results: results.map((item) => ({
        kind: item.kind,
        slug: item.slug,
        title: item.title,
        visibility: item.visibility,
        // 'cite' rather than 'source' for sources: a source referenced in
        // prose is a citation.
        reference: item.kind === 'source' ? `cite:${item.slug}` : `${item.kind}:${item.slug}`,
      })),
    });
  });

  /** Renders a body through the published pipeline, for the preview pane. */
  admin.post('/admin/essays/preview', async (request, reply) => {
    const markdown = readString(request.body, 'bodyMarkdown');
    if (markdown.length > 2_000_000) throw badRequest('That body is too long to preview.');

    const targets = await resolveForRender(pool, markdown, request.viewer);
    const rendered = renderProse(markdown, {
      targets,
      viewer: request.viewer,
      // Resolved the same way the published page resolves them, which is the
      // whole point of the preview: one that showed an event the published
      // page withholds would be worse than none.
      timelines: await resolveTimelines(pool, markdown, request.viewer),
    });

    return reply.type('application/json').send({
      html: rendered.html,
      footnotes: rendered.footnotes,
      bibliography: rendered.bibliography,
    });
  });
}
