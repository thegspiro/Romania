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
  { readonly kind: 'anonymous' } | { readonly kind: 'admin'; readonly userId: number };

export const ANONYMOUS: Viewer = Object.freeze({ kind: 'anonymous' });

export function adminViewer(userId: number): Viewer {
  return Object.freeze({ kind: 'admin', userId });
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

  return { sql: `${alias}.visibility = 'public'`, params: [] };
}

/** True when the viewer may see an item with this visibility. */
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
