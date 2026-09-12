/**
 * Administration routes.
 *
 * Everything under /admin requires a session that has passed both factors.
 * The guard is a route-level hook rather than a check inside each handler, so
 * adding a handler cannot accidentally leave it unprotected.
 */
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { badRequest, notFound } from '../http/errors.js';
import { queryOne } from '../db/pool.js';
import { isAdmin } from '../content/visibility.js';
import { isVisibility, type Visibility } from '../content/visibility.js';
import {
  createSource,
  deleteSource,
  findSourceById,
  listSources,
  setSourceVisibility,
  updateSource,
  type SourceInput,
  type SourceRecord,
  attachSourceFile,
  detachSourceFile,
} from '../content/sources.js';
import { storeStream, UnsupportedFileTypeError, UploadTooLargeError } from '../files/storage.js';
import { enqueueDerivatives, insertFileObject } from '../files/repository.js';
import {
  SOURCE_TYPES,
  formatCreators,
  formatCslDate,
  isSourceType,
  type CslItem,
} from '../citations/csl.js';
import { renderBibliographyEntry, renderNote } from '../citations/render.js';
import { recordAudit } from '../content/audit.js';
import {
  configuredLibrary,
  findSyncState,
  listZoteroDeletedSourceIds,
  requestZoteroSync,
} from '../content/zotero.js';
import {
  countUnusedRecoveryCodes,
  deleteCredential,
  findUserById,
  listCredentials,
  replaceRecoveryCodes,
} from '../auth/repository.js';
import { generateRecoveryCodes, hashRecoveryCode } from '../auth/recovery.js';
import { policyFromConfig } from '../auth/password.js';
import { actorId, flashFor, parseId, readCheckbox, readString } from './form.js';
import { registerAdminEntityRoutes } from './admin-entities.js';
import { registerAdminEssayRoutes } from './admin-essays.js';
import { registerAdminArtifactRoutes } from './admin-artifacts.js';
import { registerAdminManuscriptRoutes } from './admin-manuscripts.js';

/** Collects the source form into the repository's input shape. */
function readSourceForm(body: unknown): { input: SourceInput; errors: string[] } {
  const errors: string[] = [];

  const title = readString(body, 'title').trim();
  if (title === '') errors.push('A title is required.');
  if (title.length > 500) errors.push('The title is too long (500 characters maximum).');

  const cslType = readString(body, 'cslType').trim();
  if (!isSourceType(cslType)) errors.push('Choose a source type.');

  const visibilityRaw = readString(body, 'visibility') || 'private';
  const visibility: Visibility = isVisibility(visibilityRaw) ? visibilityRaw : 'private';

  const input: SourceInput = {
    title,
    cslType,
    titleOriginal: readString(body, 'titleOriginal'),
    summary: readString(body, 'summary'),
    language: readString(body, 'language'),
    visibility,
    noindex: readCheckbox(body, 'noindex'),
    authors: readString(body, 'authors'),
    editors: readString(body, 'editors'),
    translators: readString(body, 'translators'),
    containerTitle: readString(body, 'containerTitle'),
    collectionTitle: readString(body, 'collectionTitle'),
    publisher: readString(body, 'publisher'),
    publisherPlace: readString(body, 'publisherPlace'),
    volume: readString(body, 'volume'),
    issue: readString(body, 'issue'),
    page: readString(body, 'page'),
    edition: readString(body, 'edition'),
    genre: readString(body, 'genre'),
    medium: readString(body, 'medium'),
    issued: readString(body, 'issued'),
    accessed: readString(body, 'accessed'),
    archive: readString(body, 'archive'),
    archiveLocation: readString(body, 'archiveLocation'),
    callNumber: readString(body, 'callNumber'),
    url: readString(body, 'url'),
    doi: readString(body, 'doi'),
    isbn: readString(body, 'isbn'),
    note: readString(body, 'note'),
  };

  return { input, errors };
}

/** Turns a stored record back into the flat shape the form template expects. */
function formValuesFrom(source: SourceRecord): Record<string, unknown> {
  const csl: CslItem = source.csl;
  return {
    title: source.title,
    titleOriginal: source.titleOriginal ?? '',
    summary: source.summary ?? '',
    language: source.language ?? '',
    visibility: source.visibility,
    noindex: source.noindex,
    cslType: source.cslType,
    authors: formatCreators(csl.author),
    editors: formatCreators(csl.editor),
    translators: formatCreators(csl.translator),
    containerTitle: csl['container-title'] ?? '',
    collectionTitle: csl['collection-title'] ?? '',
    publisher: csl.publisher ?? '',
    publisherPlace: csl['publisher-place'] ?? '',
    volume: csl.volume ?? '',
    issue: csl.issue ?? '',
    page: csl.page ?? '',
    edition: csl.edition ?? '',
    genre: csl.genre ?? '',
    medium: csl.medium ?? '',
    issued: formatCslDate(csl.issued),
    accessed: formatCslDate(csl.accessed),
    archive: source.archive ?? '',
    archiveLocation: source.archiveLocation ?? '',
    callNumber: source.callNumber ?? '',
    url: source.url ?? '',
    doi: csl.DOI ?? '',
    isbn: csl.ISBN ?? '',
    note: source.notes ?? '',
  };
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const { config, pool } = context;

  await app.register(
    // Fastify's plugin contract: a plugin that does not take a `done` callback
    // must return a promise, so this has to be async even though every call
    // inside it is synchronous. The encapsulation is the point -- the guard
    // hook below applies to the routes registered here and to nothing else.
    // eslint-disable-next-line @typescript-eslint/require-await
    async (admin) => {
      // Every area registered inside this scope inherits the guard below, so
      // adding a handler cannot accidentally leave it unprotected.
      // Callback style: see the note on the preHandler hook in http/server.ts.
      // A hook with fewer than three parameters must return a promise, so a
      // synchronous guard written that way would hang every admin request.
      admin.addHook('onRequest', (request, reply, done) => {
        if (isAdmin(request.viewer)) {
          done();
          return;
        }

        // A half-authenticated visitor is sent to finish the second factor
        // rather than back to a login form they have already passed.
        const target = request.session === null ? '/login' : '/login/second-factor';
        // Replying from a hook ends the request; `done` must not also be
        // called, or Fastify would continue into the route handler.
        void reply.redirect(target);
      });

      registerAdminEntityRoutes(admin, context);
      registerAdminEssayRoutes(admin, context);
      registerAdminArtifactRoutes(admin, context);
      registerAdminManuscriptRoutes(admin, context);

      admin.get('/admin', async (request, reply) => {
        const counts = await queryOne<
          RowDataPacket & { sources: number; publicSources: number; essays: number }
        >(
          pool,
          `SELECT
             SUM(kind = 'source') AS sources,
             -- visibility-literal-ok: counts what is published for the admin
             -- dashboard. Not a viewer decision -- this page is admin-only and
             -- the number is the same whoever asks, so visibilityFilter would
             -- be the wrong tool, not merely a heavier one.
             SUM(kind = 'source' AND visibility = 'public') AS publicSources,
             SUM(kind = 'essay') AS essays
           FROM content_item`,
        );

        return renderPage(
          config,
          request,
          reply,
          'admin/dashboard',
          {
            counts: {
              sources: Number(counts?.sources ?? 0),
              publicSources: Number(counts?.publicSources ?? 0),
              essays: Number(counts?.essays ?? 0),
            },
          },
          { noindex: true, flash: flashFor(request) },
        );
      });

      // --- Sources ---------------------------------------------------------

      admin.get('/admin/sources', async (request, reply) => {
        const query = request.query as { q?: string; visibility?: string; page?: string };
        const pageNumber = Math.max(Number(query.page ?? '1') || 1, 1);
        const perPage = 25;

        const visibility = isVisibility(query.visibility) ? query.visibility : undefined;
        const result = await listSources(pool, request.viewer, {
          search: query.q,
          visibility,
          limit: perPage,
          offset: (pageNumber - 1) * perPage,
        });

        // Only queried when a library is configured, so a site that does not
        // use Zotero pays nothing for the feature being present.
        const library = configuredLibrary(config);
        const zotero =
          library === null ? null : { ...library, state: await findSyncState(pool, library) };
        const zoteroDeletedIds = library === null ? [] : await listZoteroDeletedSourceIds(pool);

        return renderPage(
          config,
          request,
          reply,
          'admin/sources/index',
          {
            sources: result.items,
            total: result.total,
            page: pageNumber,
            perPage,
            pageCount: Math.max(Math.ceil(result.total / perPage), 1),
            search: query.q ?? '',
            visibilityFilter: visibility ?? '',
            zotero,
            zoteroDeletedIds,
          },
          { noindex: true, flash: flashFor(request) },
        );
      });

      // Registered before '/admin/sources/:id' for readability; Fastify would
      // prefer the static segment either way.
      admin.post('/admin/sources/zotero-sync', async (request, reply) => {
        const library = configuredLibrary(config);
        if (library === null) {
          return reply.redirect('/admin/sources?msg=zotero_unconfigured');
        }

        const full = readCheckbox(request.body, 'full');
        const outcome = await requestZoteroSync(pool, { full });

        if (outcome === 'queued') {
          await recordAudit(
            pool,
            {
              actor: actorId(request),
              action: full ? 'zotero.sync.full' : 'zotero.sync',
              itemId: null,
              ip: request.ip,
            },
            request.log,
          );
        }

        return reply.redirect(
          `/admin/sources?msg=${outcome === 'queued' ? 'zotero_queued' : 'zotero_already_queued'}`,
        );
      });

      admin.get('/admin/sources/new', async (request, reply) => {
        return renderPage(
          config,
          request,
          reply,
          'admin/sources/form',
          {
            mode: 'create',
            action: '/admin/sources',
            sourceTypes: SOURCE_TYPES,
            values: { visibility: 'private', cslType: 'book', noindex: false },
            errors: [],
          },
          { noindex: true },
        );
      });

      admin.post('/admin/sources', async (request, reply) => {
        const { input, errors } = readSourceForm(request.body);

        if (errors.length > 0) {
          return renderPage(
            config,
            request,
            reply,
            'admin/sources/form',
            {
              mode: 'create',
              action: '/admin/sources',
              sourceTypes: SOURCE_TYPES,
              values: input,
              errors,
            },
            { status: 400, noindex: true },
          );
        }

        const id = await createSource(pool, input);
        await recordAudit(
          pool,
          {
            actor: actorId(request),
            action: 'source.create',
            itemId: id,
            detail: { title: input.title, visibility: input.visibility },
            ip: request.ip,
          },
          request.log,
        );

        return reply.redirect(`/admin/sources/${id}/edit?msg=source_created`);
      });

      admin.get('/admin/sources/:id/edit', async (request, reply) => {
        const id = parseId(request);
        const source = await findSourceById(pool, id, request.viewer);
        if (source === null) throw notFound(`source ${id}`);

        return renderPage(
          config,
          request,
          reply,
          'admin/sources/form',
          {
            mode: 'edit',
            action: `/admin/sources/${id}`,
            source,
            sourceTypes: SOURCE_TYPES,
            values: formValuesFrom(source),
            errors: [],
            maxUploadBytes: config.UPLOAD_MAX_BYTES,
            preview: {
              bibliography: renderBibliographyEntry(source.csl),
              note: renderNote(source.csl),
            },
          },
          { noindex: true, flash: flashFor(request) },
        );
      });

      admin.post('/admin/sources/:id', async (request, reply) => {
        const id = parseId(request);
        const existing = await findSourceById(pool, id, request.viewer);
        if (existing === null) throw notFound(`source ${id}`);

        const { input, errors } = readSourceForm(request.body);
        if (errors.length > 0) {
          return renderPage(
            config,
            request,
            reply,
            'admin/sources/form',
            {
              mode: 'edit',
              action: `/admin/sources/${id}`,
              source: existing,
              sourceTypes: SOURCE_TYPES,
              values: input,
              errors,
            },
            { status: 400, noindex: true },
          );
        }

        const updated = await updateSource(pool, id, input);
        if (!updated) throw notFound(`source ${id}`);

        await recordAudit(
          pool,
          {
            actor: actorId(request),
            action: 'source.update',
            itemId: id,
            detail: { title: input.title, visibility: input.visibility },
            ip: request.ip,
          },
          request.log,
        );

        return reply.redirect(`/admin/sources/${id}/edit?msg=source_updated`);
      });

      /**
       * Attaches the scan or PDF of the work itself.
       *
       * The mirror of the artifact upload, and deliberately so: the same
       * storeStream, the same magic-byte typing, the same derivative job. What
       * it changes is that a scanned article no longer has to be catalogued
       * twice -- once as a source for the footnote, once as an artifact for
       * the bytes -- with nothing linking the halves.
       *
       * Serving is unchanged: bytes go out only through /files/:id/:variant,
       * which re-checks the owning item's visibility on every request.
       */
      admin.post('/admin/sources/:id/file', async (request, reply) => {
        const id = parseId(request);
        const source = await findSourceById(pool, id, request.viewer);
        if (source === null) throw notFound(`source ${id}`);

        const upload = await request.file();
        if (upload === undefined) throw badRequest('Choose a file to upload.');

        let stored;
        try {
          stored = await storeStream(config.STORAGE_ROOT, upload.file, config.UPLOAD_MAX_BYTES);
        } catch (error) {
          if (error instanceof UploadTooLargeError || error instanceof UnsupportedFileTypeError) {
            return reply.redirect(`/admin/sources/${id}/edit?msg=source_file_rejected`);
          }
          throw error;
        }

        const fileObjectId = await insertFileObject(pool, {
          sha256: stored.sha256,
          byteSize: stored.byteSize,
          mimeType: stored.mimeType,
          // Display only; the path on disk comes from the content hash.
          originalFilename: upload.filename,
          storageKey: stored.storageKey,
        });

        await attachSourceFile(pool, id, fileObjectId);
        await enqueueDerivatives(pool, fileObjectId);
        await recordAudit(
          pool,
          {
            actor: actorId(request),
            action: 'source.update',
            itemId: id,
            detail: {
              kind: 'source',
              file: stored.sha256,
              mime: stored.mimeType,
              bytes: stored.byteSize,
            },
            ip: request.ip,
          },
          request.log,
        );

        return reply.redirect(`/admin/sources/${id}/edit?msg=source_file_attached`);
      });

      /**
       * Unlinks the file from the source.
       *
       * The file_object row and the bytes stay: they are content-addressed and
       * may still be owned by an artifact. This says something about the
       * record, not about the file.
       */
      admin.post('/admin/sources/:id/file/detach', async (request, reply) => {
        const id = parseId(request);
        const source = await findSourceById(pool, id, request.viewer);
        if (source === null) throw notFound(`source ${id}`);

        await detachSourceFile(pool, id);
        await recordAudit(
          pool,
          {
            actor: actorId(request),
            action: 'source.update',
            itemId: id,
            detail: { kind: 'source', file: null },
            ip: request.ip,
          },
          request.log,
        );

        return reply.redirect(`/admin/sources/${id}/edit?msg=source_file_detached`);
      });

      admin.post('/admin/sources/:id/visibility', async (request, reply) => {
        const id = parseId(request);
        const requested = readString(request.body, 'visibility');
        if (!isVisibility(requested)) throw badRequest('Unknown visibility value.');

        const changed = await setSourceVisibility(pool, id, requested);
        if (!changed) throw notFound(`source ${id}`);

        await recordAudit(
          pool,
          {
            actor: actorId(request),
            action: requested === 'public' ? 'source.publish' : 'source.unpublish',
            itemId: id,
            ip: request.ip,
          },
          request.log,
        );

        const message = requested === 'public' ? 'source_published' : 'source_unpublished';
        return reply.redirect(`/admin/sources?msg=${message}`);
      });

      admin.post('/admin/sources/:id/delete', async (request, reply) => {
        const id = parseId(request);
        const outcome = await deleteSource(pool, id);

        if (outcome === 'not_found') throw notFound(`source ${id}`);
        if (outcome === 'cited') return reply.redirect(`/admin/sources?msg=source_cited`);

        await recordAudit(
          pool,
          {
            actor: actorId(request),
            action: 'source.delete',
            itemId: id,
            ip: request.ip,
          },
          request.log,
        );

        return reply.redirect('/admin/sources?msg=source_deleted');
      });

      // --- Security --------------------------------------------------------

      admin.get('/admin/security', async (request, reply) => {
        if (request.viewer.kind !== 'admin') throw notFound();
        const user = await findUserById(pool, request.viewer.userId);
        if (user === null) throw notFound();

        return renderPage(
          config,
          request,
          reply,
          'admin/security',
          {
            user: { username: user.username, displayName: user.displayName },
            credentials: await listCredentials(pool, user.id),
            recoveryCodesRemaining: await countUnusedRecoveryCodes(pool, user.id),
            newRecoveryCodes: null,
          },
          { noindex: true, flash: flashFor(request) },
        );
      });

      admin.post('/admin/security/passkeys/:id/delete', async (request, reply) => {
        if (request.viewer.kind !== 'admin') throw notFound();
        const credentialId = parseId(request);
        const credentials = await listCredentials(pool, request.viewer.userId);

        // Removing the only passkey would lock the operator out of the second
        // factor entirely, leaving nothing but recovery codes.
        if (credentials.length <= 1) {
          return reply.redirect('/admin/security?msg=passkey_last');
        }

        const removed = await deleteCredential(pool, request.viewer.userId, credentialId);
        if (!removed) throw notFound(`credential ${credentialId}`);

        await recordAudit(
          pool,
          {
            actor: actorId(request),
            action: 'auth.passkey.revoked',
            itemId: credentialId,
            ip: request.ip,
          },
          request.log,
        );

        return reply.redirect('/admin/security?msg=passkey_revoked');
      });

      admin.post('/admin/security/recovery-codes', async (request, reply) => {
        if (request.viewer.kind !== 'admin') throw notFound();
        const user = await findUserById(pool, request.viewer.userId);
        if (user === null) throw notFound();

        const codes = generateRecoveryCodes();
        const policy = policyFromConfig(config);
        const hashes: string[] = [];
        for (const code of codes) {
          hashes.push(await hashRecoveryCode(code, policy));
        }
        await replaceRecoveryCodes(pool, user.id, hashes);

        await recordAudit(
          pool,
          { actor: String(user.id), action: 'auth.recovery.regenerated', ip: request.ip },
          request.log,
        );

        // Rendered directly rather than redirected to: this is the only time
        // the plaintext codes exist, and a redirect would have to carry them
        // through a URL, into browser history and into the access log.
        return renderPage(
          config,
          request,
          reply,
          'admin/security',
          {
            user: { username: user.username, displayName: user.displayName },
            credentials: await listCredentials(pool, user.id),
            recoveryCodesRemaining: codes.length,
            newRecoveryCodes: codes,
          },
          { noindex: true },
        );
      });
    },
    { prefix: '/' },
  );
}
