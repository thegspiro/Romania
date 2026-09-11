/**
 * Security response headers.
 *
 * The public side of this site is exposed to the internet, so these are set on
 * every response rather than only on admin routes: an XSS in a public source
 * page would be just as effective at stealing the admin session.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

/**
 * Content-Security-Policy.
 *
 * `default-src 'none'` means every fetch type must be listed explicitly, so a
 * new kind of subresource fails visibly during development instead of
 * silently widening the policy.
 *
 * There is no `'unsafe-inline'`. Inline scripts carry a per-response nonce and
 * inline styles are not used at all -- which is why the templates never use a
 * `style=` attribute. If maps are added later, the tile host must be added to
 * `img-src` here; nothing else should need to change.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "style-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
  ].join('; ');
}

export function applySecurityHeaders(
  config: Config,
  request: FastifyRequest,
  reply: FastifyReply,
  nonce: string,
): void {
  reply.header('Content-Security-Policy', contentSecurityPolicy(nonce));
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  // Deny the powerful features this site never uses, so a compromised page
  // cannot ask for them.
  reply.header(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );

  // HSTS is only meaningful over HTTPS, and sending it over plain HTTP in
  // development would pin the browser to a scheme the dev server does not
  // serve. Secure cookies are this deployment's signal that it is on HTTPS.
  if (config.SESSION_SECURE_COOKIES && request.protocol === 'https') {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/**
 * Search-engine and AI-crawler policy.
 *
 * Indexing is off by default. Unpublished dissertation research that has been
 * crawled, cached and archived cannot be un-crawled, so the default has to be
 * the recoverable one.
 */
export function applyIndexingHeader(
  config: Config,
  reply: FastifyReply,
  itemNoindex = false,
): void {
  if (!config.ALLOW_SEARCH_INDEXING || itemNoindex) {
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
  }
}

export function robotsTxt(config: Config): string {
  if (!config.ALLOW_SEARCH_INDEXING) {
    return ['User-agent: *', 'Disallow: /', ''].join('\n');
  }

  return [
    'User-agent: *',
    'Disallow: /admin/',
    'Disallow: /login',
    'Disallow: /logout',
    'Disallow: /auth/',
    // Share links carry a credential in the path and serve unpublished
    // chapters. Even with indexing switched on, these are never crawlable.
    'Disallow: /review/',
    '',
    `Sitemap: ${config.PUBLIC_BASE_URL}/sitemap.xml`,
    '',
  ].join('\n');
}
