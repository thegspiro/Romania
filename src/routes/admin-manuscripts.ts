/**
 * Admin routes for manuscripts: the outline, and compiling it to a document.
 *
 * The download route is where the safety property lives. A compiled file is a
 * single object containing many sections, so it is the one place a mistake
 * would disclose everything at once. Downloads require an authenticated
 * administrator, and the build's `audience` is checked against that.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { badRequest, notFound } from '../http/errors.js';
import { isVisibility } from '../content/visibility.js';
import {
  MAX_SECTION_DEPTH,
  SECTION_ROLES,
  addSection,
  createManuscript,
  deleteManuscript,
  findManuscriptById,
  isSectionRole,
  listManuscripts,
  listSections,
  moveSection,
  removeSection,
  updateManuscript,
  updateSection,
  type ManuscriptInput,
} from '../content/manuscripts.js';
import {
  BUILD_FORMATS,
  BUILD_MEDIA,
  findBuild,
  isBuildAudience,
  isBuildFormat,
  listBuilds,
  requestBuild,
} from '../content/builds.js';
import { findFileObject } from '../files/repository.js';
import { resolveStoragePath } from '../files/storage.js';
import { listEssays } from '../content/essays.js';
import { recordAudit } from '../content/audit.js';
import { actorId, flashFor, parseId, readCheckbox, readInteger, readString } from './form.js';

function readManuscriptForm(body: unknown): { input: ManuscriptInput; errors: string[] } {
  const errors: string[] = [];

  const title = readString(body, 'title').trim();
  if (title === '') errors.push('A title is required.');

  const visibilityRaw = readString(body, 'visibility') || 'private';

  return {
    input: {
      title,
      subtitle: readString(body, 'subtitle'),
      summary: readString(body, 'summary'),
      visibility: isVisibility(visibilityRaw) ? visibilityRaw : 'private',
      noindex: readCheckbox(body, 'noindex'),
      authorName: readString(body, 'authorName'),
      degree: readString(body, 'degree'),
      institution: readString(body, 'institution'),
      submittedOn: readString(body, 'submittedOn'),
      abstractMarkdown: readString(body, 'abstractMarkdown'),
      acknowledgementsMarkdown: readString(body, 'acknowledgementsMarkdown'),
      numberSections: readCheckbox(body, 'numberSections'),
    },
    errors,
  };
}

export function registerAdminManuscriptRoutes(admin: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  admin.get('/admin/manuscripts', async (request, reply) => {
    return renderPage(
      config,
      request,
      reply,
      'admin/manuscripts/index',
      { manuscripts: await listManuscripts(pool, request.viewer) },
      { noindex: true, flash: flashFor(request) },
    );
  });

  admin.get('/admin/manuscripts/new', async (request, reply) => {
    return renderPage(
      config,
      request,
      reply,
      'admin/manuscripts/form',
      {
        mode: 'create',
        action: '/admin/manuscripts',
        values: { visibility: 'private', noindex: false, numberSections: true },
        errors: [],
      },
      { noindex: true },
    );
  });

  admin.post('/admin/manuscripts', async (request, reply) => {
    const { input, errors } = readManuscriptForm(request.body);
    if (errors.length > 0) {
      return renderPage(
        config,
        request,
        reply,
        'admin/manuscripts/form',
        { mode: 'create', action: '/admin/manuscripts', values: input, errors },
        { status: 400, noindex: true },
      );
    }

    const id = await createManuscript(pool, input);
    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.create',
        itemId: id,
        detail: { kind: 'manuscript', title: input.title },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect(`/admin/manuscripts/${id}/outline?msg=manuscript_created`);
  });

  admin.get('/admin/manuscripts/:id/edit', async (request, reply) => {
    const id = parseId(request);
    const manuscript = await findManuscriptById(pool, id, request.viewer);
    if (manuscript === null) throw notFound(`manuscript ${id}`);

    return renderPage(
      config,
      request,
      reply,
      'admin/manuscripts/form',
      {
        mode: 'edit',
        action: `/admin/manuscripts/${id}`,
        manuscript,
        values: manuscript,
        errors: [],
      },
      { noindex: true, flash: flashFor(request) },
    );
  });

  admin.post('/admin/manuscripts/:id', async (request, reply) => {
    const id = parseId(request);
    const { input, errors } = readManuscriptForm(request.body);

    if (errors.length > 0) {
      const manuscript = await findManuscriptById(pool, id, request.viewer);
      if (manuscript === null) throw notFound(`manuscript ${id}`);
      return renderPage(
        config,
        request,
        reply,
        'admin/manuscripts/form',
        { mode: 'edit', action: `/admin/manuscripts/${id}`, manuscript, values: input, errors },
        { status: 400, noindex: true },
      );
    }

    if (!(await updateManuscript(pool, id, input))) throw notFound(`manuscript ${id}`);
    return reply.redirect(`/admin/manuscripts/${id}/edit?msg=manuscript_updated`);
  });

  admin.post('/admin/manuscripts/:id/delete', async (request, reply) => {
    const id = parseId(request);
    if (!(await deleteManuscript(pool, id))) throw notFound(`manuscript ${id}`);
    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.delete',
        itemId: id,
        detail: { kind: 'manuscript' },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect('/admin/manuscripts?msg=manuscript_deleted');
  });

  // --- Outline -------------------------------------------------------------

  admin.get('/admin/manuscripts/:id/outline', async (request, reply) => {
    const id = parseId(request);
    const manuscript = await findManuscriptById(pool, id, request.viewer);
    if (manuscript === null) throw notFound(`manuscript ${id}`);

    const sections = await listSections(pool, id, request.viewer);
    const placed = new Set(sections.map((section) => section.itemId));
    const essays = await listEssays(pool, request.viewer, { limit: 200 });

    return renderPage(
      config,
      request,
      reply,
      'admin/manuscripts/outline',
      {
        manuscript,
        sections,
        roles: SECTION_ROLES,
        maxDepth: MAX_SECTION_DEPTH,
        // Only offer essays that are not already in this manuscript.
        available: essays.items.filter((essay) => !placed.has(essay.id)),
        builds: await listBuilds(pool, id),
        formats: BUILD_FORMATS,
        wordCount: sections.reduce((total, section) => total + section.wordCount, 0),
      },
      { noindex: true, flash: flashFor(request) },
    );
  });

  admin.post('/admin/manuscripts/:id/sections', async (request, reply) => {
    const id = parseId(request);
    const itemId = readInteger(request.body, 'itemId', 0);
    const depth = readInteger(request.body, 'depth', 0);
    const role = readString(request.body, 'role');

    if (itemId <= 0) return reply.redirect(`/admin/manuscripts/${id}/outline?msg=section_unknown`);

    const outcome = await addSection(pool, id, itemId, {
      depth,
      role: isSectionRole(role) ? role : 'body',
    });

    if (!outcome.ok) {
      const code = outcome.reason === 'already_present' ? 'section_duplicate' : 'section_unknown';
      return reply.redirect(`/admin/manuscripts/${id}/outline?msg=${code}`);
    }
    return reply.redirect(`/admin/manuscripts/${id}/outline?msg=section_added`);
  });

  admin.post('/admin/manuscripts/:id/sections/:sectionId', async (request, reply) => {
    const id = parseId(request);
    const sectionId = parseId(request, 'sectionId');
    const role = readString(request.body, 'role');

    const changed = await updateSection(pool, id, sectionId, {
      depth: readInteger(request.body, 'depth', 0),
      role: isSectionRole(role) ? role : undefined,
      titleOverride: readString(request.body, 'titleOverride'),
    });
    if (!changed) throw notFound(`section ${sectionId}`);
    return reply.redirect(`/admin/manuscripts/${id}/outline?msg=section_updated`);
  });

  admin.post('/admin/manuscripts/:id/sections/:sectionId/move', async (request, reply) => {
    const id = parseId(request);
    const sectionId = parseId(request, 'sectionId');
    const direction = readString(request.body, 'direction') === 'up' ? 'up' : 'down';

    await moveSection(pool, id, sectionId, direction);
    return reply.redirect(`/admin/manuscripts/${id}/outline?msg=section_updated`);
  });

  admin.post('/admin/manuscripts/:id/sections/:sectionId/delete', async (request, reply) => {
    const id = parseId(request);
    const sectionId = parseId(request, 'sectionId');
    if (!(await removeSection(pool, id, sectionId))) throw notFound(`section ${sectionId}`);
    return reply.redirect(`/admin/manuscripts/${id}/outline?msg=section_removed`);
  });

  // --- Compilation ---------------------------------------------------------

  admin.post('/admin/manuscripts/:id/build', async (request, reply) => {
    const id = parseId(request);
    const manuscript = await findManuscriptById(pool, id, request.viewer);
    if (manuscript === null) throw notFound(`manuscript ${id}`);

    const format = readString(request.body, 'format');
    const audience = readString(request.body, 'audience');
    if (!isBuildFormat(format)) throw badRequest('Unknown output format.');
    if (!isBuildAudience(audience)) throw badRequest('Unknown audience.');

    const result = await requestBuild(pool, config, manuscript, {
      format,
      audience,
      requestedBy: request.viewer.kind === 'admin' ? request.viewer.userId : null,
    });

    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.update',
        itemId: id,
        detail: {
          kind: 'manuscript.build',
          buildId: result.buildId,
          format,
          audience,
          sections: result.sectionCount,
          withheldCitations: result.withheldCitations,
        },
        ip: request.ip,
      },
      request.log,
    );

    return reply.redirect(`/admin/manuscripts/${id}/outline?msg=build_queued`);
  });

  /**
   * Downloads a compiled document.
   *
   * Reachable only inside the authenticated admin scope, and the build's
   * `audience` is checked as well: a build assembled for the public is served
   * as such, and an 'admin' build -- which contains private sections -- is
   * never reachable by any other route in the application.
   */
  admin.get('/admin/manuscripts/:id/builds/:buildId/download', async (request, reply) => {
    const id = parseId(request);
    const buildId = parseId(request, 'buildId');

    const build = await findBuild(pool, buildId);
    if (build === null || build.manuscriptItemId !== id) throw notFound(`build ${buildId}`);
    if (build.state !== 'succeeded' || build.fileObjectId === null) {
      throw notFound(`build ${buildId} has no output`);
    }

    const file = await findFileObject(pool, build.fileObjectId);
    if (file === null) throw notFound(`build ${buildId} output is missing`);

    const path = resolveStoragePath(config.STORAGE_ROOT, file.storageKey);
    try {
      await stat(path);
    } catch {
      throw notFound(`build ${buildId} output is missing from storage`);
    }

    const media = BUILD_MEDIA[build.format];
    const filename = `manuscript-${build.audience}-${build.id}.${media.extension}`;

    return (
      reply
        .type(media.mimeType)
        // attachment, not inline: an HTML build rendered in place would run in
        // this origin, and a compiled document is meant to be saved anyway.
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(createReadStream(path))
    );
  });
}
