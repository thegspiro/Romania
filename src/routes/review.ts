/**
 * The reviewer's side of a share link.
 *
 * Two routes, both reachable without signing in, which makes this the most
 * security-sensitive file in `src/routes`. Four rules hold it together:
 *
 *   1. **One door.** `resolveShare` is the only thing that turns a token into
 *      an essay id, and it refuses expired and revoked links. Nothing here
 *      re-implements that check or works around it.
 *   2. **The viewer does the rest.** `shareViewer(essayId)` widens
 *      `visibilityFilter` by one id. Everything after that -- the read, the
 *      renderer, reference resolution -- behaves exactly as it does for an
 *      anonymous visitor, so a private person named in the chapter stays
 *      withheld from the reviewer too.
 *   3. **404 for every refusal.** Unknown, expired, revoked and
 *      wrong-shaped all answer identically. Distinguishing them would say
 *      whether a chapter exists behind a guessed token.
 *   4. **Nothing is stored or indexed.** `no-store` and a noindex header on
 *      both routes, and `Referrer-Policy: no-referrer` so the token in the URL
 *      is not handed to anything the page links to.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../http/server.js';
import { renderPage } from '../http/context.js';
import { notFound } from '../http/errors.js';
import { shareViewer } from '../content/visibility.js';
import { findEssayById } from '../content/essays.js';
import { renderProse } from '../content/markdown.js';
import { resolveForRender, resolveTimelines } from '../content/render-context.js';
import {
  addShareComment,
  listCommentsFromShare,
  recordShareView,
  resolveShare,
  MAX_COMMENT_LENGTH,
} from '../content/sharing.js';
import { readInteger, readString } from './form.js';

/**
 * A token is a path segment, so it is checked against the same shape
 * `looksLikeShareToken` enforces before it reaches a query. Anything else is
 * indistinguishable from a wrong token.
 */
function tokenFrom(request: { params: unknown }): string {
  const raw = (request.params as Record<string, string | undefined>).token ?? '';
  return raw;
}

export function registerReviewRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, pool } = context;

  /**
   * Applied to both routes.
   *
   * `no-store` rather than `no-cache`: an unpublished chapter must not sit in
   * a shared proxy or a disk cache after the link expires. `no-referrer`
   * because the credential is in the URL, and a referrer header would hand it
   * to every host the page links out to.
   */
  const sealResponse = (reply: { header: (name: string, value: string) => unknown }): void => {
    reply.header('Cache-Control', 'no-store, max-age=0, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex');
  };

  app.get('/review/:token', async (request, reply) => {
    const resolution = await resolveShare(pool, tokenFrom(request));
    sealResponse(reply);

    if (!resolution.ok) {
      // The reason goes to the log, never to the response.
      request.log.info({ reason: resolution.reason }, 'share link refused');
      throw notFound('share link');
    }

    const { share } = resolution;
    const viewer = shareViewer(share.essayId);

    const essay = await findEssayById(pool, share.essayId, viewer);
    if (essay === null) {
      // The essay was deleted while the link was live.
      request.log.info({ shareId: share.id }, 'share link points at a deleted essay');
      throw notFound('share link');
    }

    const rendered = renderProse(essay.bodyMarkdown, {
      targets: await resolveForRender(pool, essay.bodyMarkdown, viewer),
      viewer,
      timelines: await resolveTimelines(pool, essay.bodyMarkdown, viewer),
    });

    await recordShareView(pool, share.id);

    return renderPage(
      config,
      request,
      reply,
      'review/show',
      {
        essay,
        rendered,
        token: tokenFrom(request),
        expiresAt: share.expiresAt,
        comments: await listCommentsFromShare(pool, share.id),
        maxCommentLength: MAX_COMMENT_LENGTH,
      },
      { noindex: true },
    );
  });

  /**
   * A comment from the reviewer.
   *
   * CSRF is the ordinary site-wide check: a visitor with no session is issued
   * a standalone token cookie by `establishCsrfToken`, and the form carries
   * the matching value. Nothing special is needed here, which is the point --
   * this route is not exempt from anything.
   */
  app.post('/review/:token/comments', async (request, reply) => {
    const resolution = await resolveShare(pool, tokenFrom(request));
    sealResponse(reply);

    if (!resolution.ok) {
      request.log.info({ reason: resolution.reason }, 'share comment refused');
      throw notFound('share link');
    }

    const { share } = resolution;
    const body = readString(request.body, 'body');
    // 0 means "the chapter as a whole"; addShareComment normalises anything
    // that is not a positive integer to null.
    const blockIndex = readInteger(request.body, 'blockIndex', 0);

    await addShareComment(pool, {
      essayId: share.essayId,
      shareId: share.id,
      blockIndex: blockIndex > 0 ? blockIndex : null,
      body,
    });

    return reply.redirect(`/review/${tokenFrom(request)}?msg=comment_added`);
  });
}
