/**
 * Admin routes for artifacts, including upload.
 *
 * Uploads are typed by magic bytes and stored under their content hash, so
 * nothing a user typed ever reaches a filesystem path.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { badRequest, notFound } from '../http/errors.js';
import { isVisibility } from '../content/visibility.js';
import {
  attachFile,
  createArtifact,
  deleteArtifact,
  findArtifactById,
  listArtifacts,
  setArtifactVisibility,
  updateArtifact,
  type ArtifactInput,
} from '../content/artifacts.js';
import { listMentionsOf } from '../content/mentions.js';
import { UnsupportedFileTypeError, UploadTooLargeError, storeStream } from '../files/storage.js';
import { enqueueDerivatives, insertFileObject } from '../files/repository.js';
import { recordAudit } from '../content/audit.js';
import { actorId, flashFor, parseId, readCheckbox, readString } from './form.js';

function readArtifactForm(body: unknown): { input: ArtifactInput; errors: string[] } {
  const errors: string[] = [];

  const title = readString(body, 'title').trim();
  if (title === '') errors.push('A title is required.');
  if (title.length > 500) errors.push('The title is too long (500 characters maximum).');

  const visibilityRaw = readString(body, 'visibility') || 'private';

  return {
    input: {
      title,
      titleOriginal: readString(body, 'titleOriginal'),
      language: readString(body, 'language'),
      summary: readString(body, 'summary'),
      visibility: isVisibility(visibilityRaw) ? visibilityRaw : 'private',
      noindex: readCheckbox(body, 'noindex'),
      provenance: readString(body, 'provenance'),
      repositoryName: readString(body, 'repositoryName'),
      physicalLocation: readString(body, 'physicalLocation'),
      dateCreated: readString(body, 'dateCreated'),
      creditLine: readString(body, 'creditLine'),
      rightsStatement: readString(body, 'rightsStatement'),
    },
    errors,
  };
}

export function registerAdminArtifactRoutes(admin: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  admin.get('/admin/artifacts', async (request, reply) => {
    const query = request.query as { q?: string; visibility?: string; page?: string };
    const pageNumber = Math.max(Number(query.page ?? '1') || 1, 1);
    const perPage = 25;
    const visibility = isVisibility(query.visibility) ? query.visibility : undefined;

    const result = await listArtifacts(pool, request.viewer, {
      search: query.q,
      visibility,
      limit: perPage,
      offset: (pageNumber - 1) * perPage,
    });

    return renderPage(
      config,
      request,
      reply,
      'admin/artifacts/index',
      {
        artifacts: result.items,
        total: result.total,
        page: pageNumber,
        pageCount: Math.max(Math.ceil(result.total / perPage), 1),
        search: query.q ?? '',
        visibilityFilter: visibility ?? '',
      },
      { noindex: true, flash: flashFor(request) },
    );
  });

  admin.get('/admin/artifacts/new', async (request, reply) => {
    return renderPage(
      config,
      request,
      reply,
      'admin/artifacts/form',
      {
        mode: 'create',
        action: '/admin/artifacts',
        values: { visibility: 'private', noindex: false },
        errors: [],
      },
      { noindex: true },
    );
  });

  admin.post('/admin/artifacts', async (request, reply) => {
    const { input, errors } = readArtifactForm(request.body);
    if (errors.length > 0) {
      return renderPage(
        config,
        request,
        reply,
        'admin/artifacts/form',
        { mode: 'create', action: '/admin/artifacts', values: input, errors },
        { status: 400, noindex: true },
      );
    }

    const id = await createArtifact(pool, input);
    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.create',
        itemId: id,
        detail: { kind: 'artifact', title: input.title },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect(`/admin/artifacts/${id}/edit?msg=artifact_created`);
  });

  admin.get('/admin/artifacts/:id/edit', async (request, reply) => {
    const id = parseId(request);
    const artifact = await findArtifactById(pool, id, request.viewer);
    if (artifact === null) throw notFound(`artifact ${id}`);

    return renderPage(
      config,
      request,
      reply,
      'admin/artifacts/form',
      {
        mode: 'edit',
        action: `/admin/artifacts/${id}`,
        artifact,
        values: artifact,
        errors: [],
        maxUploadBytes: config.UPLOAD_MAX_BYTES,
        mentions: await listMentionsOf(pool, id, request.viewer),
      },
      { noindex: true, flash: flashFor(request) },
    );
  });

  admin.post('/admin/artifacts/:id', async (request, reply) => {
    const id = parseId(request);
    const existing = await findArtifactById(pool, id, request.viewer);
    if (existing === null) throw notFound(`artifact ${id}`);

    const { input, errors } = readArtifactForm(request.body);
    if (errors.length > 0) {
      return renderPage(
        config,
        request,
        reply,
        'admin/artifacts/form',
        {
          mode: 'edit',
          action: `/admin/artifacts/${id}`,
          artifact: existing,
          values: input,
          errors,
          maxUploadBytes: config.UPLOAD_MAX_BYTES,
        },
        { status: 400, noindex: true },
      );
    }

    if (!(await updateArtifact(pool, id, input))) throw notFound(`artifact ${id}`);
    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.update',
        itemId: id,
        detail: { kind: 'artifact' },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect(`/admin/artifacts/${id}/edit?msg=artifact_updated`);
  });

  /**
   * Attaches a file to an artifact.
   *
   * The stream is hashed and sniffed as it is written, so an oversized or
   * unrecognised file is rejected without ever being fully buffered in memory.
   */
  admin.post('/admin/artifacts/:id/file', async (request, reply) => {
    const id = parseId(request);
    const artifact = await findArtifactById(pool, id, request.viewer);
    if (artifact === null) throw notFound(`artifact ${id}`);

    const upload = await request.file();
    if (upload === undefined) throw badRequest('Choose a file to upload.');

    let stored;
    try {
      stored = await storeStream(config.STORAGE_ROOT, upload.file, config.UPLOAD_MAX_BYTES);
    } catch (error) {
      if (error instanceof UploadTooLargeError || error instanceof UnsupportedFileTypeError) {
        return renderPage(
          config,
          request,
          reply,
          'admin/artifacts/form',
          {
            mode: 'edit',
            action: `/admin/artifacts/${id}`,
            artifact,
            values: artifact,
            errors: [error.message],
            maxUploadBytes: config.UPLOAD_MAX_BYTES,
          },
          { status: 400, noindex: true },
        );
      }
      throw error;
    }

    const fileObjectId = await insertFileObject(pool, {
      sha256: stored.sha256,
      byteSize: stored.byteSize,
      mimeType: stored.mimeType,
      // The submitted filename is stored for display only; the path on disk
      // comes from the content hash.
      originalFilename: upload.filename,
      storageKey: stored.storageKey,
    });

    await attachFile(pool, id, fileObjectId);
    await enqueueDerivatives(pool, fileObjectId);
    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.update',
        itemId: id,
        detail: {
          kind: 'artifact',
          file: stored.sha256,
          mime: stored.mimeType,
          bytes: stored.byteSize,
        },
        ip: request.ip,
      },
      request.log,
    );

    return reply.redirect(`/admin/artifacts/${id}/edit?msg=file_uploaded`);
  });

  admin.post('/admin/artifacts/:id/visibility', async (request, reply) => {
    const id = parseId(request);
    const requested = readString(request.body, 'visibility');
    if (!isVisibility(requested)) throw badRequest('Unknown visibility value.');

    if (!(await setArtifactVisibility(pool, id, requested))) throw notFound(`artifact ${id}`);
    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: requested === 'public' ? 'source.publish' : 'source.unpublish',
        itemId: id,
        detail: { kind: 'artifact' },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect(
      `/admin/artifacts?msg=${requested === 'public' ? 'entity_published' : 'entity_unpublished'}`,
    );
  });

  admin.post('/admin/artifacts/:id/delete', async (request, reply) => {
    const id = parseId(request);
    const outcome = await deleteArtifact(pool, id);

    if (outcome === 'not_found') throw notFound(`artifact ${id}`);
    if (outcome === 'referenced') {
      return reply.redirect(`/admin/artifacts/${id}/edit?msg=entity_referenced`);
    }

    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'source.delete',
        itemId: id,
        detail: { kind: 'artifact' },
        ip: request.ip,
      },
      request.log,
    );
    return reply.redirect('/admin/artifacts?msg=artifact_deleted');
  });
}
