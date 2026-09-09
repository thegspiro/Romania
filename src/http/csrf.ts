/**
 * Cross-site request forgery protection.
 *
 * A single rule, applied to every state-changing request: the submitted token
 * must equal the one in the CSRF cookie.
 *
 * The token comes from the session row once the visitor has one, so it rotates
 * whenever privilege changes (`promoteSession` issues a new one when the
 * second factor succeeds). Before login there is no session, so a standalone
 * cookie token is issued instead -- the login form needs the same protection
 * as everything else, and creating a database row for every anonymous request
 * would be a free denial-of-service.
 *
 * SameSite=Lax on both cookies already blocks cross-site form posts in current
 * browsers. This token is the second layer, and covers same-site subdomains,
 * which SameSite does not.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { csrfTokenMatches } from '../auth/session.js';
import { forbidden } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfCookieName(config: Config): string {
  return config.SESSION_SECURE_COOKIES ? '__Host-dsp_csrf' : 'dsp_csrf';
}

export function cookieOptions(config: Config): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
} {
  return {
    path: '/',
    httpOnly: true,
    secure: config.SESSION_SECURE_COOKIES,
    // Lax rather than Strict: Strict would drop the session cookie when the
    // operator follows a link to the site from anywhere else, presenting a
    // logged-out page to someone who is in fact logged in.
    sameSite: 'lax',
  };
}

/**
 * Establishes `request.csrfToken`, issuing the cookie when it is missing or
 * has drifted from the session's token.
 */
export function establishCsrfToken(
  config: Config,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const name = csrfCookieName(config);
  const fromCookie = request.cookies[name];
  const fromSession = request.session?.csrfToken;

  if (fromSession !== undefined) {
    request.csrfToken = fromSession;
    if (fromCookie !== fromSession) {
      reply.setCookie(name, fromSession, cookieOptions(config));
    }
    return;
  }

  if (typeof fromCookie === 'string' && fromCookie.length >= 20) {
    request.csrfToken = fromCookie;
    return;
  }

  const issued = randomBytes(32).toString('base64url');
  request.csrfToken = issued;
  reply.setCookie(name, issued, cookieOptions(config));
}

interface MaybeCsrfBody {
  _csrf?: unknown;
}

/** Throws when a state-changing request does not carry a matching token. */
export function assertCsrf(request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) return;

  const body = request.body as MaybeCsrfBody | undefined;
  const submitted = body?._csrf ?? request.headers['x-csrf-token'];

  if (!csrfTokenMatches(request.csrfToken, submitted)) {
    throw forbidden(
      'Your session expired or the form was stale. Reload the page and try again.',
      `CSRF token mismatch on ${request.method} ${request.url}`,
    );
  }
}
