/**
 * Fastify application assembly.
 *
 * Request lifecycle, in order:
 *
 *   onRequest   generate the CSP nonce, resolve the session cookie, set the
 *               viewer, establish the CSRF token, apply security headers
 *   preHandler  verify the CSRF token on state-changing requests
 *   handler     route
 *   error       map to a rendered page; unexpected errors are logged in full
 *               and reported to the visitor as a bare 500
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import nunjucks from 'nunjucks';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { loadSession } from '../auth/session.js';
import { ANONYMOUS, adminViewer } from '../content/visibility.js';
import { assertCsrf, cookieOptions, establishCsrfToken } from './csrf.js';
import { HttpError, tooManyRequests } from './errors.js';
import { renderPage } from './context.js';
import { applySecurityHeaders, robotsTxt } from './security.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { registerAdminRoutes } from '../routes/admin.js';
import { registerPublicRoutes } from '../routes/public.js';
import { registerPublicContentRoutes } from '../routes/public-content.js';
import { registerTimelineRoutes } from '../routes/timeline.js';
import { registerMapRoutes } from '../routes/map.js';
import { registerReviewRoutes } from '../routes/review.js';

export interface AppContext {
  config: Config;
  pool: Pool;
}

const VIEWS_ROOT = fileURLToPath(new URL('../views/', import.meta.url));
const PUBLIC_ROOT = fileURLToPath(new URL('../../public/', import.meta.url));

export function sessionCookieOptions(config: Config): ReturnType<typeof cookieOptions> & {
  maxAge: number;
} {
  return { ...cookieOptions(config), maxAge: Math.floor(config.sessionTtlMs / 1000) };
}

export async function buildServer(context: AppContext): Promise<FastifyInstance> {
  const { config, pool } = context;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        // These would otherwise land in the log on every request, and the log
        // is the one place a session token must never appear.
        paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        remove: true,
      },
    },
    // Only trust X-Forwarded-* when a reverse proxy is actually in front;
    // otherwise a client could spoof its address and defeat login throttling.
    trustProxy: config.TRUST_PROXY,
    // Titles, notes and Markdown bodies are the largest thing posted here.
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);

  // Uploads. The per-file limit is enforced again while streaming, in
  // storeStream, so the two cannot drift apart.
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.UPLOAD_MAX_BYTES, files: 1, fields: 40 },
  });

  await app.register(fastifyView, {
    engine: { nunjucks },
    root: VIEWS_ROOT,
    viewExt: 'njk',
    options: {
      // Nunjucks escapes by default; this makes the dependency explicit so
      // that a future options change cannot silently turn it off.
      autoescape: true,
      throwOnUndefined: false,
      noCache: config.NODE_ENV === 'development',
    },
  });

  await app.register(fastifyStatic, {
    root: PUBLIC_ROOT,
    prefix: '/assets/',
    index: false,
    // Vendored libraries are content-stable for the life of a release.
    maxAge: config.NODE_ENV === 'production' ? '7d' : 0,
  });

  // `viewer` is deliberately not decorated: Fastify 5 rejects reference-type
  // request decorators because one object would be shared by every request.
  // The onRequest hook below assigns it before any handler can observe it,
  // and the module augmentation in http/context.ts gives it its type.
  app.decorateRequest('session', null);
  app.decorateRequest('cspNonce', '');
  app.decorateRequest('csrfToken', '');

  app.addHook('onRequest', async (request, reply) => {
    request.cspNonce = randomBytes(16).toString('base64');
    request.viewer = ANONYMOUS;
    request.session = null;

    const token = request.cookies[config.sessionCookieName];
    if (typeof token === 'string' && token !== '') {
      const session = await loadSession(pool, token, config.sessionTtlMs);
      if (session === null) {
        // Stale or forged token: clear it so the browser stops sending it.
        reply.clearCookie(config.sessionCookieName, cookieOptions(config));
      } else {
        request.session = session;
        // Only a session that has cleared BOTH factors becomes an admin
        // viewer. A 'password_pending' session can read nothing private.
        if (session.authState === 'authenticated') {
          request.viewer = adminViewer(session.userId);
        }
      }
    }

    establishCsrfToken(config, request, reply);
    applySecurityHeaders(config, request, reply, request.cspNonce);
  });

  // Callback style, because there is nothing to await here. Fastify decides
  // how to drive a hook from its arity: with fewer than three parameters it
  // waits on the returned promise, so a synchronous two-argument hook would
  // hang every request. Taking `done` selects the synchronous contract, and
  // Fastify routes a throw from it to the error handler.
  app.addHook('preHandler', (request, _reply, done) => {
    assertCsrf(request);
    done();
  });

  /*
   * Rate limiting, registered globally and on purpose.
   *
   * Every route that serves a file -- `/manuscripts/:slug/download`,
   * `/files/:id/:variant`, the admin build download -- reads from disk on
   * every request, and the published download is deliberately `no-store`, so
   * nothing in front of the application absorbs a repeat. One registration
   * covers all of them and every route added later; a per-route limiter is a
   * rule the fourth such route would have to remember.
   *
   * Registered *after* the onRequest hook above, which is what makes
   * `request.viewer` readable in `allowList`. Fastify appends hooks in the
   * order they are added during boot, so moving this call earlier would run
   * the limiter before the viewer exists and break the exemption --
   * `tests/integration/rate-limit.test.ts` pins the exemption, so that
   * mistake fails rather than silently throttling the operator.
   *
   * What the key means depends on `TRUST_PROXY`, and this is the trap worth
   * knowing about: with it off, `request.ip` is the socket address, so behind
   * a reverse proxy every visitor shares the proxy's bucket. That is why the
   * default is generous rather than tight -- a limit that takes the site down
   * for everyone is not protection -- and why the address in use is logged at
   * startup.
   */
  await app.register(fastifyRateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_SECONDS * 1000,
    // In-memory, which is per process and resets on restart. That is the
    // right store for this: the limit sheds load, it does not lock an account
    // out, so there is nothing worth persisting and nothing worth a database
    // write in front of every request.
    allowList: (request) => {
      // A signed-in administrator is exempt. An attacker cannot hold an admin
      // session, sign-in is throttled separately by `login_attempt`, and the
      // operator loading a page full of vendored assets and artifact images
      // should not throttle themselves out of their own editor.
      if (request.viewer.kind === 'admin') return true;
      // The container healthcheck. Throttling it would mark the service
      // unhealthy and restart it, turning a burst of reader traffic into an
      // outage -- the opposite of what a limiter is for.
      return request.routeOptions.url === '/healthz';
    },
    // The plugin *throws* whatever this returns, so returning the
    // application's own error type routes the refusal through the same error
    // handler as everything else: a rendered page rather than the plugin's
    // JSON, and `noindex` like every other error. Without it a 429 rendered
    // as "Bad request", which is both wrong and useless to the reader -- the
    // one thing they need to know is that waiting fixes it.
    errorResponseBuilder: (_request, context) =>
      tooManyRequests(
        `Too many requests. Try again in ${context.after}.`,
        `rate limit of ${context.max} exceeded`,
      ),
  });

  app.log.info(
    { trustProxy: config.TRUST_PROXY, max: config.RATE_LIMIT_MAX },
    config.TRUST_PROXY
      ? 'rate limiting by forwarded client address'
      : 'rate limiting by socket address; set TRUST_PROXY=true if a reverse proxy is in front',
  );

  app.get('/healthz', async (_request, reply) => {
    // Touches the database so an unhealthy pool is reported as unhealthy.
    await pool.query('SELECT 1');
    return reply.type('application/json').send({ status: 'ok' });
  });

  app.get('/robots.txt', async (_request, reply) => {
    return reply
      .type('text/plain; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(robotsTxt(config));
  });

  registerAuthRoutes(app, context);
  await registerAdminRoutes(app, context);
  registerPublicRoutes(app, context);
  registerPublicContentRoutes(app, context);
  registerTimelineRoutes(app, context);
  registerMapRoutes(app, context);
  registerReviewRoutes(app, context);

  app.setNotFoundHandler(async (request, reply) => {
    return renderPage(config, request, reply, 'errors/404', {}, { status: 404, noindex: true });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof HttpError) {
      request.log.info(
        { err: error, statusCode: error.statusCode, url: request.url },
        'request rejected',
      );
      return renderPage(
        config,
        request,
        reply,
        error.statusCode === 404 ? 'errors/404' : 'errors/error',
        { statusCode: error.statusCode, message: error.publicMessage },
        { status: error.statusCode, noindex: true },
      );
    }

    // Body-parsing and validation failures Fastify raises itself. The handler
    // receives `unknown`, so the status code is read defensively.
    const candidate: unknown =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const statusCode = typeof candidate === 'number' ? candidate : 500;
    if (statusCode >= 400 && statusCode < 500) {
      request.log.info({ err: error, url: request.url }, 'bad request');
      return renderPage(
        config,
        request,
        reply,
        'errors/error',
        { statusCode, message: 'Bad request' },
        { status: statusCode, noindex: true },
      );
    }

    // Unexpected: log everything, tell the visitor nothing. An internal
    // message can name a table, a query or a file path.
    request.log.error({ err: error, url: request.url }, 'unhandled error');
    return renderPage(
      config,
      request,
      reply,
      'errors/error',
      { statusCode: 500, message: 'Something went wrong.' },
      { status: 500, noindex: true },
    );
  });

  return app;
}
