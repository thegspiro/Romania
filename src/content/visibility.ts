/**
 * The public/private rule.
 *
 * This module is the single place where "may this viewer see this item?" is
 * decided. Every read path takes a `Viewer` and every query that can reach a
 * content item applies `visibilityFilter`. Nothing else in the codebase is
 * permitted to write `visibility = 'public'` into a WHERE clause: one
 * chokepoint is auditable, a rule scattered across route handlers is not.
 *
 * Three invariants hold, and `tests/integration/visibility.test.ts` asserts
 * each of them:
 *
 *   1. A private item is 404 to an anonymous visitor, never 403. A 403 would
 *      confirm the item exists, which for unpublished research about named
 *      people is itself the disclosure.
 *   2. A public page that references a private item renders the reference as
 *      plain text, never a link, and never leaks its title or slug.
 *   3. File bytes are reachable only through a route that re-applies this
 *      filter to the owning item on every request.
 */
import type { SqlParam } from '../db/pool.js';
import { referenceHref } from './references.js';

export type Viewer =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'admin'; readonly userId: number }
  /**
   * Someone holding a valid share link for exactly one essay.
   *
   * This is the only way anything unpublished becomes readable without
   * signing in, and it is expressed **here** rather than as a bypass
   * somewhere else on purpose. If a share were served by a read that skipped
   * `visibilityFilter`, there would be two answers to "may this viewer see
   * this item?" in the codebase, and only one of them auditable.
   *
   * The widening is one id. A private person named in the shared chapter, a
   * private source it cites, another unpublished essay it links to -- all
   * stay withheld from the holder exactly as they would from any visitor,
   * because the filter below says `public OR this id` and nothing more.
   */
  | { readonly kind: 'share'; readonly essayId: number };

export const ANONYMOUS: Viewer = Object.freeze({ kind: 'anonymous' });

export function adminViewer(userId: number): Viewer {
  return Object.freeze({ kind: 'admin', userId });
}

/**
 * A viewer for one shared essay.
 *
 * `essayId` must come from a share row that was looked up by token hash and
 * checked for expiry and revocation. Nothing downstream re-checks that: this
 * function is where a validated token becomes an access decision, so the
 * caller is responsible for the validation.
 */
export function shareViewer(essayId: number): Viewer {
  if (!Number.isSafeInteger(essayId) || essayId <= 0) {
    throw new TypeError(`Invalid essay id for a share viewer: ${String(essayId)}`);
  }
  return Object.freeze({ kind: 'share', essayId });
}

export function isAdmin(viewer: Viewer): viewer is { kind: 'admin'; userId: number } {
  return viewer.kind === 'admin';
}

export type Visibility = 'private' | 'public';

export function isVisibility(value: unknown): value is Visibility {
  return value === 'private' || value === 'public';
}

/** Table aliases are written into SQL, so they are restricted to a safe shape. */
const SAFE_ALIAS = /^[a-z_][a-z0-9_]*$/;

export interface SqlFragment {
  sql: string;
  params: SqlParam[];
}

/**
 * Returns a WHERE fragment restricting rows to what `viewer` may see.
 *
 * Always combine it with AND; it is never empty, so a caller cannot forget it
 * and still produce syntactically valid SQL that happens to leak.
 */
export function visibilityFilter(viewer: Viewer, alias = 'ci'): SqlFragment {
  if (!SAFE_ALIAS.test(alias)) {
    throw new TypeError(`Unsafe SQL alias "${alias}"`);
  }

  if (isAdmin(viewer)) {
    // The administrator sees everything. Written as a true predicate rather
    // than an empty string so callers can always AND it in unconditionally.
    return { sql: '1 = 1', params: [] };
  }

  if (viewer.kind === 'share') {
    // Everything public, plus the single item the link was issued for. The id
    // is bound, never interpolated, and the predicate is parenthesised so a
    // caller ANDing it cannot accidentally widen it by operator precedence.
    return {
      sql: `(${alias}.visibility = 'public' OR ${alias}.id = ?)`,
      params: [viewer.essayId],
    };
  }

  return { sql: `${alias}.visibility = 'public'`, params: [] };
}

/**
 * True when the viewer may see an item with this visibility.
 *
 * A share viewer is deliberately **not** given its one extra id here. This
 * function is asked about reference targets -- "may you follow this link?" --
 * and the answer for a link holder is the same as for any visitor: only if it
 * is published. The essay they were sent is reached through
 * `visibilityFilter`, not through this.
 */
export function canView(viewer: Viewer, visibility: Visibility): boolean {
  return isAdmin(viewer) || visibility === 'public';
}

/**
 * A reference from one item to another, resolved for display.
 *
 * `linkable` is false when the target exists but the viewer may not see it.
 * Templates must render a non-linkable reference as plain text and must not
 * print `title` or `slug` for it -- which is why those fields are null.
 */
export interface ResolvedReference {
  linkable: boolean;
  title: string | null;
  href: string | null;
}

export function resolveReference(
  viewer: Viewer,
  target: { kind: string; slug: string; title: string; visibility: Visibility } | null,
  placeholder = 'Reference withheld',
): ResolvedReference {
  if (target === null) {
    return { linkable: false, title: placeholder, href: null };
  }
  if (!canView(viewer, target.visibility)) {
    return { linkable: false, title: placeholder, href: null };
  }
  return {
    linkable: true,
    title: target.title,
    href: referenceHref(target.kind, target.slug),
  };
}
