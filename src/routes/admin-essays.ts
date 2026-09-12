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
  countEssayRevisions,
  createEssay,
  deleteEssay,
  findEssayById,
  findEssayRevision,
  findPreviousRevision,
  isEssayStatus,
  listEssayRevisions,
  listEssays,
  setEssayVisibility,
  updateEssay,
  type EssayInput,
} from '../content/essays.js';
import { collapseUnchanged, diffLines } from '../content/diff.js';
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
import {
  countUnresolvedComments,
  issueShare,
  listShareComments,
  listShares,
  revokeShare,
  setCommentResolved,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  MIN_EXPIRY_DAYS,
} from '../content/sharing.js';
import {
  actorId,
  filterQuery,
  flashFor,
  parseId,
  readCheckbox,
  readInteger,
  readString,
} from './form.js';

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
        filterQuery: filterQuery({ q: query.q, visibility }),
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
        shares: await listShares(pool, id),
        shareComments: await listShareComments(pool, id),
        unresolvedComments: await countUnresolvedComments(pool, id),
        defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
        minExpiryDays: MIN_EXPIRY_DAYS,
        maxExpiryDays: MAX_EXPIRY_DAYS,
        // Shown once, immediately after issuing, and never again: the token is
        // stored hashed and cannot be recovered.
        issuedShareUrl: (request.query as { link?: string }).link ?? null,
        revisionCount: await countEssayRevisions(pool, id),
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

  // --- Share links ---------------------------------------------------------

  /**
   * Issues a link that lets one person read one unpublished chapter.
   *
   * The deliberate exception to the rule the rest of the application enforces,
   * so it is narrow on purpose: one essay, a mandatory expiry, revocable at
   * any time, and the token is shown exactly once because only its hash is
   * kept.
   */
  admin.post('/admin/essays/:id/shares', async (request, reply) => {
    const id = parseId(request);
    const essay = await findEssayById(pool, id, request.viewer);
    if (essay === null) throw notFound(`essay ${id}`);

    const issued = await issueShare(pool, {
      essayId: id,
      label: readString(request.body, 'label'),
      expiresInDays: readInteger(request.body, 'expiresInDays', DEFAULT_EXPIRY_DAYS),
    });

    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.update',
        itemId: id,
        detail: {
          kind: 'essay',
          share: 'issued',
          shareId: issued.share.id,
          // The label, never the token.
          label: issued.share.label,
        },
        ip: request.ip,
      },
      request.log,
    );

    // The token travels back in the query string so the page can show it once.
    // It is already in the operator's browser history either way, which is why
    // the page says to copy it and move on.
    const url = `${config.PUBLIC_BASE_URL}/review/${issued.token}`;
    return reply.redirect(
      `/admin/essays/${id}/edit?msg=share_issued&link=${encodeURIComponent(url)}`,
    );
  });

  admin.post('/admin/essays/:id/shares/:shareId/revoke', async (request, reply) => {
    const id = parseId(request);
    const shareId = parseId(request, 'shareId');

    const essay = await findEssayById(pool, id, request.viewer);
    if (essay === null) throw notFound(`essay ${id}`);
    if (!(await revokeShare(pool, id, shareId))) throw notFound(`share ${shareId}`);

    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.update',
        itemId: id,
        detail: { kind: 'essay', share: 'revoked', shareId },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect(`/admin/essays/${id}/edit?msg=share_revoked`);
  });

  /** Marks a reviewer's comment dealt with, or puts it back. */
  admin.post('/admin/essays/:id/comments/:commentId/resolve', async (request, reply) => {
    const id = parseId(request);
    const commentId = parseId(request, 'commentId');

    const essay = await findEssayById(pool, id, request.viewer);
    if (essay === null) throw notFound(`essay ${id}`);

    const resolved = readString(request.body, 'resolved') !== 'false';
    if (!(await setCommentResolved(pool, id, commentId, resolved))) {
      throw notFound(`comment ${commentId}`);
    }

    return reply.redirect(
      `/admin/essays/${id}/edit?msg=${resolved ? 'comment_resolved' : 'comment_reopened'}`,
    );
  });

  // --- Revisions -----------------------------------------------------------

  /**
   * The history of one essay.
   *
   * `findEssayById` runs first and with the request's viewer, so a revision
   * listing is reachable only for an essay that viewer could already open.
   * The revision reads themselves take no viewer, and this is the check that
   * makes that safe.
   */
  admin.get('/admin/essays/:id/revisions', async (request, reply) => {
    const id = parseId(request);
    const essay = await findEssayById(pool, id, request.viewer);
    if (essay === null) throw notFound(`essay ${id}`);

    const revisions = await listEssayRevisions(pool, id);

    return renderPage(
      config,
      request,
      reply,
      'admin/essays/revisions',
      {
        essay,
        revisions,
        // The newest revision is the current text, so there is nothing to
        // restore it to and the listing says so rather than offering a
        // button that would do nothing.
        currentRevision: revisions[0]?.revisionNumber ?? null,
      },
      { noindex: true, flash: flashFor(request) },
    );
  });

  /** One revision, compared against the one before it. */
  admin.get('/admin/essays/:id/revisions/:revision', async (request, reply) => {
    const id = parseId(request);
    const number = parseId(request, 'revision');

    const essay = await findEssayById(pool, id, request.viewer);
    if (essay === null) throw notFound(`essay ${id}`);

    const revision = await findEssayRevision(pool, id, number);
    if (revision === null) throw notFound(`essay ${id} revision ${number}`);

    const previous = await findPreviousRevision(pool, id, number);
    // The first revision has nothing before it, so it is shown whole rather
    // than as a diff against an empty document that would mark every line new.
    const diff = previous === null ? null : diffLines(previous.bodyMarkdown, revision.bodyMarkdown);

    return renderPage(
      config,
      request,
      reply,
      'admin/essays/revision',
      {
        essay,
        revision,
        previous,
        summary: diff?.summary ?? null,
        hunks: diff === null ? null : collapseUnchanged(diff.lines),
        titleChanged: previous !== null && previous.title !== revision.title,
        statusChanged: previous !== null && previous.status !== revision.status,
        isCurrent: revision.revisionNumber === (await countEssayRevisions(pool, id)),
      },
      { noindex: true },
    );
  });

  /**
   * Restores an earlier revision.
   *
   * Deliberately an ordinary save: it goes through `updateEssay`, so
   * `rebuildReferences` runs over the restored prose and a *new* revision is
   * appended recording where the text came from. Nothing rewinds, and nothing
   * in the history is rewritten -- the mistake and its correction both stay.
   *
   * What is restored is the title, the body and the status. Visibility is not:
   * whether a piece of research is published is a decision about now, never a
   * property of old text, and silently republishing something by restoring a
   * revision is exactly the disclosure this application exists to prevent.
   */
  admin.post('/admin/essays/:id/revisions/:revision/restore', async (request, reply) => {
    const id = parseId(request);
    const number = parseId(request, 'revision');

    const essay = await findEssayById(pool, id, request.viewer);
    if (essay === null) throw notFound(`essay ${id}`);

    const revision = await findEssayRevision(pool, id, number);
    if (revision === null) throw notFound(`essay ${id} revision ${number}`);

    const input: EssayInput = {
      title: revision.title,
      bodyMarkdown: revision.bodyMarkdown,
      status: revision.status,
      // Carried from the essay as it stands, not from the revision.
      titleOriginal: essay.titleOriginal ?? '',
      language: essay.language ?? '',
      summary: essay.summary ?? '',
      visibility: essay.visibility,
      noindex: essay.noindex,
    };

    const result = await updateEssay(pool, id, input, {
      source: 'restore',
      restoredFrom: number,
    });
    if (result === null) throw notFound(`essay ${id}`);

    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.update',
        itemId: id,
        detail: {
          kind: 'essay',
          restoredFrom: number,
          mentions: result.references.mentions,
          citations: result.references.citations,
        },
        ip: request.ip,
      },
      request.log,
    );

    return reply.redirect(`/admin/essays/${id}/edit?msg=essay_restored`);
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
