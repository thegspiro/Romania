/**
 * Per-request context and the view-rendering helper.
 *
 * Every template is rendered through `renderPage` so that the CSP nonce, the
 * CSRF token and the viewer are always present. A template that reached for
 * one of these and found it missing would fail open -- a form without a CSRF
 * token, or a script tag without a nonce that then gets "fixed" by loosening
 * the policy -- so they are supplied centrally rather than per route.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { SessionRecord } from '../auth/session.js';
import { ANONYMOUS, isAdmin, type Viewer } from '../content/visibility.js';
import { applyIndexingHeader } from './security.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who is asking. Never undefined: the hook sets it on every request. */
    viewer: Viewer;
    /** Present once a session cookie has been resolved, authenticated or not. */
    session: SessionRecord | null;
    /** Per-response CSP nonce. */
    cspNonce: string;
    /** Token every state-changing request must echo back. See `csrf.ts`. */
    csrfToken: string;
  }
}

export interface PageOptions {
  /** HTTP status for the response. Defaults to 200. */
  status?: number;
  /** Per-item indexing opt-out, in addition to the site-wide setting. */
  noindex?: boolean;
  /** Message shown once at the top of the page. */
  flash?: { kind: 'success' | 'error' | 'info'; text: string } | null;
}

export interface BaseContext {
  viewer: Viewer;
  isAdmin: boolean;
  nonce: string;
  csrfToken: string;
  allowIndexing: boolean;
  baseUrl: string;
  flash: { kind: string; text: string } | null;
  currentPath: string;
}

export function baseContext(
  config: Config,
  request: FastifyRequest,
  flash: PageOptions['flash'] = null,
): BaseContext {
  return {
    viewer: request.viewer ?? ANONYMOUS,
    isAdmin: isAdmin(request.viewer ?? ANONYMOUS),
    nonce: request.cspNonce,
    csrfToken: request.csrfToken,
    allowIndexing: config.ALLOW_SEARCH_INDEXING,
    baseUrl: config.PUBLIC_BASE_URL,
    flash: flash ?? null,
    currentPath: new URL(request.url, config.PUBLIC_BASE_URL).pathname,
  };
}

export async function renderPage(
  config: Config,
  request: FastifyRequest,
  reply: FastifyReply,
  template: string,
  data: Record<string, unknown> = {},
  options: PageOptions = {},
): Promise<void> {
  applyIndexingHeader(config, reply, options.noindex ?? false);
  reply.status(options.status ?? 200);
  reply.type('text/html; charset=utf-8');
  return reply.view(template, { ...baseContext(config, request, options.flash), ...data });
}
