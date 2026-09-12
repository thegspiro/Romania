/**
 * Admin routes for people, organizations, places and events.
 *
 * All four share one set of handlers, parameterised by kind, because they
 * share one repository. Registered inside the authenticated scope in
 * `admin.ts`, so the guard covers them without being repeated.
 */
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import type { AppContext } from '../http/server.js';
import { queryOne } from '../db/pool.js';
import { renderPage } from '../http/context.js';
import { badRequest, notFound } from '../http/errors.js';
import { isVisibility } from '../content/visibility.js';
import {
  ENTITY_KINDS,
  ENTITY_LABELS,
  createEntity,
  deleteEntity,
  findEntityById,
  listEntities,
  setEntityVisibility,
  updateEntity,
  type EntityInput,
  type EntityKind,
} from '../content/entities.js';
import { KIND_PATHS } from '../content/references.js';
import { listMentionsOf } from '../content/mentions.js';
import {
  MAX_ROLE_TITLE,
  createRelationship,
  deleteRelationship,
  isLinkableKind,
  isPeriodPrecision,
  listPredicateChoices,
  listRelationshipsFor,
  parsePredicateChoice,
  setRelationshipVisibility,
  type LinkableKind,
} from '../content/relationships.js';
import {
  findEventBoundSlugs,
  parseSlugList,
  setEventBounds,
  type EventBoundsInput,
} from '../content/timeline.js';
import { recordAudit } from '../content/audit.js';
import { requestGeocode } from '../content/places.js';
import { actorId, filterQuery, flashFor, parseId, readCheckbox, readString } from './form.js';

/** Detail fields each kind reads from its form. */
const DETAIL_FIELDS: Readonly<Record<EntityKind, readonly string[]>> = Object.freeze({
  person: [
    'familyName',
    'givenName',
    'alternateNames',
    'birthDate',
    'deathDate',
    'occupation',
    'biography',
  ],
  organization: ['alternateNames', 'foundedDate', 'dissolvedDate', 'occupation', 'biography'],
  place: [
    'latitude',
    'longitude',
    'geocodePrecision',
    'countryCode',
    'adminArea',
    'historicalNames',
  ],
  event: [
    'startDate',
    'startTime',
    'endDate',
    'endTime',
    'startPrecision',
    'endPrecision',
    'isCirca',
    'placeSlug',
    'bodyMarkdown',
  ],
});

/**
 * The relative bounds posted alongside an event.
 *
 * These are not detail columns: a bound is a `happened_after` edge in the
 * relationship table, for the reason migration 0008 gives. They are read here
 * so the event form can offer "after" and "before" fields, rather than making
 * the operator record "X before Y" by editing Y and getting the direction
 * backwards.
 */
function readEventBounds(kind: EntityKind, body: unknown): EventBoundsInput | null {
  if (kind !== 'event') return null;

  // Written with the event's own visibility, which is the intuitive reading:
  // a published event's bounds are published with it. Safe regardless, because
  // every read filters the anchor as well as the edge -- a public bound
  // pointing at an unpublished event still shows nothing.
  const requested = readString(body, 'visibility');

  return {
    afterSlugs: parseSlugList(readString(body, 'afterSlugs')),
    beforeSlugs: parseSlugList(readString(body, 'beforeSlugs')),
    visibility: isVisibility(requested) ? requested : 'private',
  };
}

/** The bounds already recorded, as the two comma-separated form fields. */
async function boundFields(
  pool: AppContext['pool'],
  eventId: number,
): Promise<{ afterSlugs: string; beforeSlugs: string }> {
  const bounds = await findEventBoundSlugs(pool, eventId);
  return {
    afterSlugs: bounds.afterSlugs.join(', '),
    beforeSlugs: bounds.beforeSlugs.join(', '),
  };
}

function readEntityForm(kind: EntityKind, body: unknown): { input: EntityInput; errors: string[] } {
  const errors: string[] = [];

  const title = readString(body, 'title').trim();
  if (title === '') errors.push('A name is required.');
  if (title.length > 500) errors.push('The name is too long (500 characters maximum).');

  const visibilityRaw = readString(body, 'visibility') || 'private';

  const detail: Record<string, string> = {};
  for (const field of DETAIL_FIELDS[kind]) detail[field] = readString(body, field);

  return {
    input: {
      title,
      titleOriginal: readString(body, 'titleOriginal'),
      language: readString(body, 'language'),
      summary: readString(body, 'summary'),
      visibility: isVisibility(visibilityRaw) ? visibilityRaw : 'private',
      noindex: readCheckbox(body, 'noindex'),
      detail,
    },
    errors,
  };
}

export function registerAdminEntityRoutes(admin: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  for (const kind of ENTITY_KINDS) {
    const path = KIND_PATHS[kind]!;
    const labels = ENTITY_LABELS[kind];

    admin.get(`/admin/${path}`, async (request, reply) => {
      const query = request.query as { q?: string; visibility?: string; page?: string };
      const pageNumber = Math.max(Number(query.page ?? '1') || 1, 1);
      const perPage = 25;
      const visibility = isVisibility(query.visibility) ? query.visibility : undefined;

      const result = await listEntities(pool, kind, request.viewer, {
        search: query.q,
        visibility,
        limit: perPage,
        offset: (pageNumber - 1) * perPage,
      });

      return renderPage(
        config,
        request,
        reply,
        'admin/entities/index',
        {
          kind,
          path,
          labels,
          items: result.items,
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

    admin.get(`/admin/${path}/new`, async (request, reply) => {
      return renderPage(
        config,
        request,
        reply,
        'admin/entities/form',
        {
          kind,
          path,
          labels,
          mode: 'create',
          action: `/admin/${path}`,
          values: { visibility: 'private', noindex: false },
          errors: [],
        },
        { noindex: true },
      );
    });

    admin.post(`/admin/${path}`, async (request, reply) => {
      const { input, errors } = readEntityForm(kind, request.body);
      if (errors.length > 0) {
        return renderPage(
          config,
          request,
          reply,
          'admin/entities/form',
          {
            kind,
            path,
            labels,
            mode: 'create',
            action: `/admin/${path}`,
            values: { ...input, ...input.detail },
            errors,
          },
          { status: 400, noindex: true },
        );
      }

      const { id } = await createEntity(pool, kind, input);

      const bounds = readEventBounds(kind, request.body);
      if (bounds !== null) await setEventBounds(pool, id, bounds);

      await recordAudit(
        pool,
        {
          actor: actorId(request),
          action: 'source.create',
          itemId: id,
          detail: { kind, title: input.title, visibility: input.visibility },
          ip: request.ip,
        },
        request.log,
      );
      return reply.redirect(`/admin/${path}/${id}/edit?msg=entity_created`);
    });

    admin.get(`/admin/${path}/:id/edit`, async (request, reply) => {
      const id = parseId(request);
      const record = await findEntityById(pool, kind, id, request.viewer);
      if (record === null) throw notFound(`${kind} ${id}`);

      return renderPage(
        config,
        request,
        reply,
        'admin/entities/form',
        {
          kind,
          path,
          labels,
          mode: 'edit',
          action: `/admin/${path}/${id}`,
          record,
          values: {
            ...record,
            ...record.detail,
            ...(kind === 'event' ? await boundFields(pool, id) : {}),
          },
          errors: [],
          relationships: await listRelationshipsFor(pool, id, request.viewer),
          predicateChoices: await listPredicateChoices(pool),
          mentions: await listMentionsOf(pool, id, request.viewer),
        },
        { noindex: true, flash: flashFor(request) },
      );
    });

    if (kind === 'place') {
      // Registered before '/admin/places/:id' so the static segment is
      // unambiguous; Fastify would prefer it either way.
      //
      // The web service never calls Nominatim. It queues the job and the
      // worker does the lookup, for the same reason the Zotero API key lives
      // only in the worker: the process facing the internet holds no
      // credential and makes no outbound request on a visitor's behalf.
      admin.post(`/admin/${path}/:id/geocode`, async (request, reply) => {
        const id = parseId(request);
        const existing = await findEntityById(pool, kind, id, request.viewer);
        if (existing === null) throw notFound(`${kind} ${id}`);

        const outcome = await requestGeocode(pool, id);

        if (outcome === 'queued') {
          await recordAudit(
            pool,
            {
              actor: actorId(request),
              action: 'place.geocode',
              itemId: id,
              ip: request.ip,
            },
            request.log,
          );
        }

        return reply.redirect(
          `/admin/${path}/${id}/edit?msg=${
            outcome === 'queued' ? 'geocode_queued' : 'geocode_already_queued'
          }`,
        );
      });
    }

    admin.post(`/admin/${path}/:id`, async (request, reply) => {
      const id = parseId(request);
      const existing = await findEntityById(pool, kind, id, request.viewer);
      if (existing === null) throw notFound(`${kind} ${id}`);

      const { input, errors } = readEntityForm(kind, request.body);
      if (errors.length > 0) {
        return renderPage(
          config,
          request,
          reply,
          'admin/entities/form',
          {
            kind,
            path,
            labels,
            mode: 'edit',
            action: `/admin/${path}/${id}`,
            record: existing,
            values: { ...input, ...input.detail },
            errors,
            relationships: await listRelationshipsFor(pool, id, request.viewer),
            predicateChoices: await listPredicateChoices(pool),
            mentions: await listMentionsOf(pool, id, request.viewer),
          },
          { status: 400, noindex: true },
        );
      }

      if ((await updateEntity(pool, kind, id, input)) === null) throw notFound(`${kind} ${id}`);

      const bounds = readEventBounds(kind, request.body);
      if (bounds !== null) await setEventBounds(pool, id, bounds);

      await recordAudit(
        pool,
        {
          actor: actorId(request),
          action: 'source.update',
          itemId: id,
          detail: { kind, title: input.title },
          ip: request.ip,
        },
        request.log,
      );
      return reply.redirect(`/admin/${path}/${id}/edit?msg=entity_updated`);
    });

    admin.post(`/admin/${path}/:id/visibility`, async (request, reply) => {
      const id = parseId(request);
      const requested = readString(request.body, 'visibility');
      if (!isVisibility(requested)) throw badRequest('Unknown visibility value.');

      if (!(await setEntityVisibility(pool, kind, id, requested))) throw notFound(`${kind} ${id}`);
      await recordAudit(
        pool,
        {
          actor: actorId(request),
          action: requested === 'public' ? 'source.publish' : 'source.unpublish',
          itemId: id,
          detail: { kind },
          ip: request.ip,
        },
        request.log,
      );

      return reply.redirect(
        `/admin/${path}?msg=${requested === 'public' ? 'entity_published' : 'entity_unpublished'}`,
      );
    });

    admin.post(`/admin/${path}/:id/delete`, async (request, reply) => {
      const id = parseId(request);
      const outcome = await deleteEntity(pool, kind, id);

      if (outcome === 'not_found') throw notFound(`${kind} ${id}`);
      if (outcome === 'referenced') {
        return reply.redirect(`/admin/${path}/${id}/edit?msg=entity_referenced`);
      }

      await recordAudit(
        pool,
        {
          actor: actorId(request),
          action: 'source.delete',
          itemId: id,
          detail: { kind },
          ip: request.ip,
        },
        request.log,
      );
      return reply.redirect(`/admin/${path}?msg=entity_deleted`);
    });
  }

  // --- Relationships -------------------------------------------------------
  //
  // Shared by every kind: the edge table does not care what it connects.

  admin.post('/admin/relationships', async (request, reply) => {
    // The item whose page the form was on. It is the `from` end for a forward
    // reading and the `to` end for a reverse one, which is the whole point of
    // offering both: an edge is asserted from wherever the operator is
    // standing, and the direction it is *stored* in should not decide which
    // page they have to be on to record it.
    const ownItemId = Number(readString(request.body, 'fromItemId'));

    // A form posting only `predicateId` is read as the forward direction --
    // which is what that field always meant, so an older form still works.
    const choice = parsePredicateChoice(readString(request.body, 'predicate')) ?? {
      predicateId: Number(readString(request.body, 'predicateId')),
      reverse: false,
    };

    const targetSlug = readString(request.body, 'targetSlug').trim();
    const targetKindRaw = readString(request.body, 'targetKind').trim();
    const visibility = readString(request.body, 'visibility');
    const returnTo = readString(request.body, 'returnTo');

    if (
      !Number.isSafeInteger(ownItemId) ||
      !Number.isSafeInteger(choice.predicateId) ||
      !isLinkableKind(targetKindRaw) ||
      !/^[a-z0-9-]{1,190}$/.test(targetSlug)
    ) {
      return reply.redirect(`${safeReturn(returnTo)}?msg=relationship_invalid`);
    }

    // An office is a property of the edge, not of either endpoint, so it is
    // read here alongside the predicate. A malformed date is normalised away
    // by createRelationship rather than refused; an over-long title is not,
    // because silently truncating an office would misstate the record.
    const roleTitle = readString(request.body, 'roleTitle').trim();
    if (roleTitle.length > MAX_ROLE_TITLE) {
      return reply.redirect(`${safeReturn(returnTo)}?msg=relationship_role_long`);
    }
    const datePrecision = readString(request.body, 'datePrecision');

    const target = await findItemIdBySlug(targetKindRaw, targetSlug);
    if (target === null) return reply.redirect(`${safeReturn(returnTo)}?msg=relationship_invalid`);

    // The reverse reading swaps the ends, so one row is stored whichever page
    // it was entered from and the duplicate check still sees them as one edge.
    const fromItemId = choice.reverse ? target : ownItemId;
    const toItemId = choice.reverse ? ownItemId : target;

    const outcome = await createRelationship(pool, {
      fromItemId,
      toItemId,
      predicateId: choice.predicateId,
      roleTitle,
      startDate: readString(request.body, 'startDate'),
      endDate: readString(request.body, 'endDate'),
      datePrecision: isPeriodPrecision(datePrecision) ? datePrecision : 'unknown',
      note: readString(request.body, 'note').trim() || null,
      visibility: isVisibility(visibility) ? visibility : 'private',
    });

    if (!outcome.ok) {
      const code =
        outcome.reason === 'duplicate'
          ? 'relationship_duplicate'
          : outcome.reason === 'role_too_long'
            ? 'relationship_role_long'
            : 'relationship_invalid';
      return reply.redirect(`${safeReturn(returnTo)}?msg=${code}`);
    }

    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: 'relationship.create',
        itemId: fromItemId,
        detail: {
          toItemId,
          predicateId: choice.predicateId,
          visibility,
          relationshipId: outcome.id,
        },
        ip: request.ip,
      },
      request.log,
    );

    return reply.redirect(`${safeReturn(returnTo)}?msg=relationship_added`);
  });

  admin.post('/admin/relationships/:id/delete', async (request, reply) => {
    const id = parseId(request);
    const returnTo = readString(request.body, 'returnTo');
    const removed = await deleteRelationship(pool, id);

    if (removed) {
      await recordAudit(
        pool,
        {
          actor: actorId(request),
          action: 'relationship.delete',
          detail: { relationshipId: id },
          ip: request.ip,
        },
        request.log,
      );
    }

    return reply.redirect(`${safeReturn(returnTo)}?msg=relationship_removed`);
  });

  /**
   * Publishes or withdraws one edge.
   *
   * An edge has its own visibility because the connection between two people
   * can be more sensitive than either page, and until now that could only be
   * chosen when the edge was created -- so publishing a relationship later
   * meant deleting it and entering it again. The repository function for this
   * existed from the start and had no route.
   */
  admin.post('/admin/relationships/:id/visibility', async (request, reply) => {
    const id = parseId(request);
    const requested = readString(request.body, 'visibility');
    const returnTo = readString(request.body, 'returnTo');
    if (!isVisibility(requested)) throw badRequest('Unknown visibility value.');

    if (!(await setRelationshipVisibility(pool, id, requested))) {
      throw notFound(`relationship ${id}`);
    }

    await recordAudit(
      pool,
      {
        actor: actorId(request),
        action: requested === 'public' ? 'relationship.publish' : 'relationship.unpublish',
        detail: { relationshipId: id },
        ip: request.ip,
      },
      request.log,
    );

    return reply.redirect(
      `${safeReturn(returnTo)}?msg=relationship_${requested === 'public' ? 'published' : 'unpublished'}`,
    );
  });

  /**
   * Constrains a redirect target to a path within this site.
   *
   * A `returnTo` taken from a form is attacker-controllable; anything that is
   * not a bare admin path becomes the dashboard rather than an open redirect.
   */
  function safeReturn(value: string): string {
    return /^\/admin\/[A-Za-z0-9/_-]{0,190}$/.test(value) ? value : '/admin';
  }

  /**
   * Resolves the far end of a relationship by kind and slug.
   *
   * Not visibility-filtered: only an administrator reaches this route, and a
   * relationship to a private item is exactly the case the edge's own
   * visibility column exists for.
   */
  async function findItemIdBySlug(kind: LinkableKind, slug: string): Promise<number | null> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      pool,
      'SELECT id FROM content_item WHERE kind = ? AND slug = ?',
      [kind, slug],
    );
    return row === null ? null : Number(row.id);
  }
}
