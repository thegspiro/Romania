/**
 * Reading HTML form submissions.
 *
 * Request bodies arrive as `unknown`. Every field is read through these
 * helpers, which narrow explicitly rather than casting, so a missing or
 * hostile field becomes an empty string instead of `undefined` propagating
 * into a query.
 */
import type { FastifyRequest } from 'fastify';
import { notFound } from '../http/errors.js';

export function readString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === 'string' ? value : '';
}

export function readCheckbox(body: unknown, field: string): boolean {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return value === 'on' || value === 'true' || value === '1';
}

export function readInteger(body: unknown, field: string, fallback: number): number {
  const parsed = Number(readString(body, field));
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * The query string a paging link must carry, minus `page` itself.
 *
 * A listing's filters live in the query string, so a "Next" link that does not
 * repeat them silently returns an unfiltered page under a filter form still
 * showing the old values. Blank and undefined values are dropped so the link
 * stays short, and every value is encoded.
 *
 * Returns '' when nothing is filtered, which is what the pagination macro
 * treats as "no extra parameters".
 */
export function filterQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.trim() !== '') search.set(key, value);
  }
  return search.toString();
}

/** Reads a positive integer route parameter, 404ing on anything else. */
export function parseId(request: FastifyRequest, parameter = 'id'): number {
  const raw = (request.params as Record<string, string | undefined>)[parameter] ?? '';
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound(`invalid ${parameter} "${raw}"`);
  return id;
}

/**
 * Reads a slug route parameter.
 *
 * Slugs are produced by `slugify`, so anything outside that alphabet cannot
 * name a real row and is refused before it reaches SQL.
 */
export function parseSlug(request: FastifyRequest, parameter = 'slug'): string {
  const slug = (request.params as Record<string, string | undefined>)[parameter] ?? '';
  if (!/^[a-z0-9-]{1,190}$/.test(slug)) throw notFound(`invalid slug "${slug}"`);
  return slug;
}

export type Flash = { kind: 'success' | 'error' | 'info'; text: string };

/**
 * Messages addressed by code.
 *
 * Redirects carry a code, never text, so nothing from a query string is ever
 * rendered into a page.
 */
export const FLASH_MESSAGES: Readonly<Record<string, Flash>> = Object.freeze({
  source_created: { kind: 'success', text: 'Source created.' },
  source_updated: { kind: 'success', text: 'Source updated.' },
  source_deleted: { kind: 'success', text: 'Source deleted.' },
  source_file_attached: {
    kind: 'success',
    text: 'File attached. Derivatives are being generated.',
  },
  source_file_detached: {
    kind: 'success',
    text: 'File unlinked from this source. The file itself was not deleted.',
  },
  source_file_rejected: {
    kind: 'error',
    text: 'That file was rejected: it is either too large or not a type this site accepts.',
  },
  source_published: { kind: 'success', text: 'Source is now public.' },
  source_unpublished: { kind: 'success', text: 'Source is now private.' },
  zotero_queued: {
    kind: 'success',
    text: 'Zotero sync queued. Refresh in a moment for the result.',
  },
  zotero_already_queued: {
    kind: 'info',
    text: 'A Zotero sync is already waiting to run.',
  },
  zotero_unconfigured: {
    kind: 'error',
    text: 'Set ZOTERO_LIBRARY_ID and ZOTERO_API_KEY before syncing a library.',
  },
  source_cited: {
    kind: 'error',
    text: 'That source is still cited by other items, so it was not deleted. Remove the citations first.',
  },
  passkey_revoked: { kind: 'success', text: 'Passkey removed.' },
  passkey_last: {
    kind: 'error',
    text: 'That is your only passkey. Register another before removing this one.',
  },

  entity_created: { kind: 'success', text: 'Created.' },
  entity_updated: { kind: 'success', text: 'Saved.' },
  entity_deleted: { kind: 'success', text: 'Deleted.' },
  entity_published: { kind: 'success', text: 'Now public.' },
  entity_unpublished: { kind: 'success', text: 'Now private.' },
  entity_referenced: {
    kind: 'error',
    text: 'Your writing still refers to this, so it was not deleted. Remove those references first.',
  },

  relationship_added: { kind: 'success', text: 'Relationship added.' },
  relationship_removed: { kind: 'success', text: 'Relationship removed.' },
  relationship_duplicate: {
    kind: 'error',
    text: 'That relationship already exists with the same role and period.',
  },
  relationship_role_long: {
    kind: 'error',
    text: 'That role or position is too long (255 characters maximum).',
  },
  relationship_invalid: { kind: 'error', text: 'Choose a different item and a relationship type.' },
  relationship_published: { kind: 'success', text: 'Relationship is now public.' },
  relationship_unpublished: { kind: 'success', text: 'Relationship is now private.' },

  essay_created: { kind: 'success', text: 'Essay created.' },
  essay_updated: { kind: 'success', text: 'Essay saved.' },
  essay_deleted: { kind: 'success', text: 'Essay deleted.' },
  comment_added: { kind: 'success', text: 'Your comment was sent to the author.' },
  share_issued: {
    kind: 'success',
    text: 'Link created. Copy it now — it is shown once and cannot be recovered.',
  },
  share_revoked: {
    kind: 'success',
    text: 'Link revoked. It stops working on the next request.',
  },
  comment_resolved: { kind: 'success', text: 'Comment marked as dealt with.' },
  comment_reopened: { kind: 'success', text: 'Comment reopened.' },
  essay_restored: {
    kind: 'success',
    text: 'Revision restored as a new revision. The earlier text is still in the history.',
  },

  artifact_created: { kind: 'success', text: 'Artifact created.' },
  artifact_updated: { kind: 'success', text: 'Artifact saved.' },
  artifact_deleted: { kind: 'success', text: 'Artifact deleted.' },
  file_uploaded: { kind: 'success', text: 'File uploaded. Derivatives are being generated.' },

  manuscript_created: { kind: 'success', text: 'Manuscript created.' },
  manuscript_updated: { kind: 'success', text: 'Manuscript saved.' },
  manuscript_deleted: { kind: 'success', text: 'Manuscript deleted.' },
  section_added: { kind: 'success', text: 'Added to the outline.' },
  section_removed: { kind: 'success', text: 'Removed from the outline.' },
  section_updated: { kind: 'success', text: 'Outline updated.' },
  section_duplicate: { kind: 'error', text: 'That item is already in this manuscript.' },
  section_unknown: { kind: 'error', text: 'No such item to add.' },
  build_queued: {
    kind: 'success',
    text: 'Compilation queued. Refresh in a moment for the result.',
  },

  geocode_queued: {
    kind: 'success',
    text:
      'Lookup queued. Coordinates you entered by hand are never overwritten, ' +
      'so clear them first if you want the result to win.',
  },
  geocode_already_queued: { kind: 'success', text: 'A lookup for this place is already queued.' },
});

export function flashFor(request: FastifyRequest): Flash | null {
  const code = (request.query as { msg?: unknown } | undefined)?.msg;
  if (typeof code !== 'string') return null;
  return FLASH_MESSAGES[code] ?? null;
}

/** The signed-in administrator's id, for audit entries. */
export function actorId(request: FastifyRequest): string {
  return request.viewer.kind === 'admin' ? String(request.viewer.userId) : 'unknown';
}
