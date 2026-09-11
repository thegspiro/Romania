/**
 * Share links: the one deliberate exception to the rule everything else here
 * enforces.
 *
 * A link hands an unauthenticated reader an unpublished chapter. That is worth
 * building, and it is a hole by design, so this suite is mostly about how
 * small the hole is:
 *
 *   - it widens exactly one item, and a private person, source or essay named
 *     in that item stays withheld from the holder;
 *   - unknown, expired and revoked links are indistinguishable from each other
 *     and from a chapter that does not exist;
 *   - revocation takes effect on the next request, not at expiry;
 *   - nothing about it is cacheable, indexable, or referrer-leaking.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import {
  createHarness,
  databaseAvailable,
  getPage,
  postForm,
  signIn,
  truncateContent,
  type Harness,
} from './helpers.js';
import { execute, queryOne } from '../../src/db/pool.js';
import { createEssay, findEssayById } from '../../src/content/essays.js';
import { createEntity } from '../../src/content/entities.js';
import {
  issueShare,
  listShareComments,
  listShares,
  resolveShare,
  revokeShare,
  setCommentResolved,
} from '../../src/content/sharing.js';
import { adminViewer, shareViewer, visibilityFilter } from '../../src/content/visibility.js';

const available = await databaseAvailable();

describe.skipIf(!available)('share links', () => {
  let harness: Harness;
  let admin: Map<string, string>;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
    admin = await signIn(harness);
  });

  async function essay(title: string, body: string, visibility: 'public' | 'private') {
    const result = await createEssay(harness.pool, {
      title,
      titleOriginal: '',
      language: '',
      summary: '',
      visibility,
      noindex: false,
      bodyMarkdown: body,
      status: 'draft',
    });
    return result.id;
  }

  async function person(title: string, visibility: 'public' | 'private'): Promise<void> {
    await createEntity(harness.pool, 'person', {
      title,
      titleOriginal: '',
      language: '',
      summary: '',
      visibility,
      noindex: false,
      detail: {},
    });
  }

  async function share(essayId: number, days = 30) {
    return issueShare(harness.pool, { essayId, label: 'Prof. Ionescu', expiresInDays: days });
  }

  // --- The filter ----------------------------------------------------------

  it('widens the filter by exactly one id', () => {
    const fragment = visibilityFilter(shareViewer(42), 'ci');

    expect(fragment.sql).toBe("(ci.visibility = 'public' OR ci.id = ?)");
    // Bound, never interpolated.
    expect(fragment.params).toEqual([42]);
  });

  it('refuses to build a viewer for a nonsense id', () => {
    expect(() => shareViewer(0)).toThrow(TypeError);
    expect(() => shareViewer(-1)).toThrow(TypeError);
    expect(() => shareViewer(1.5)).toThrow(TypeError);
  });

  // --- Resolving -----------------------------------------------------------

  it('resolves a live token to its essay', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);

    const resolution = await resolveShare(harness.pool, issued.token);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.share.essayId).toBe(id);
  });

  it('stores only the hash of the token', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);

    const row = await queryOne<RowDataPacket & { token_sha256: string }>(
      harness.pool,
      'SELECT token_sha256 FROM essay_share WHERE id = ?',
      [issued.share.id],
    );
    // A dump of this table must not let anyone read anything.
    expect(row?.token_sha256).not.toBe(issued.token);
    expect(row?.token_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unknown, malformed or empty token', async () => {
    for (const candidate of ['', 'nope', 'a'.repeat(43), null, undefined, 42, { token: 'x' }]) {
      const resolution = await resolveShare(harness.pool, candidate);
      expect(resolution.ok).toBe(false);
    }
  });

  it('refuses an expired link', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);
    await execute(
      harness.pool,
      'UPDATE essay_share SET expires_at = NOW(3) - INTERVAL 1 DAY WHERE id = ?',
      [issued.share.id],
    );

    const resolution = await resolveShare(harness.pool, issued.token);
    expect(resolution).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a revoked link on the very next request', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);
    expect((await resolveShare(harness.pool, issued.token)).ok).toBe(true);

    await revokeShare(harness.pool, id, issued.share.id);

    // Not at expiry -- immediately. "I sent that to the wrong address" needs a
    // faster answer than a deadline.
    expect(await resolveShare(harness.pool, issued.token)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('will not revoke a link belonging to another chapter', async () => {
    const first = await essay('First', 'Prose.', 'private');
    const second = await essay('Second', 'Prose.', 'private');
    const issued = await share(first);

    expect(await revokeShare(harness.pool, second, issued.share.id)).toBe(false);
    expect((await resolveShare(harness.pool, issued.token)).ok).toBe(true);
  });

  // --- What the holder can reach -------------------------------------------

  it('serves the shared chapter over HTTP', async () => {
    const id = await essay('A Draft Chapter', 'The commission met in July.', 'private');
    const issued = await share(id);

    const response = await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('The commission met in July.');
    expect(response.body).toContain('A Draft Chapter');
  });

  it('answers 404 for every refusal, alike', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);
    await revokeShare(harness.pool, id, issued.share.id);

    const revoked = await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });
    const unknown = await harness.app.inject({
      method: 'GET',
      url: `/review/${'a'.repeat(43)}`,
    });
    const malformed = await harness.app.inject({ method: 'GET', url: '/review/nope' });

    // Distinguishing them would say whether a chapter exists behind a guess.
    expect(revoked.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
  });

  it('does not reach a private person the chapter names', async () => {
    // The widening is one id. Everything else behaves as it does for a visitor.
    await person('A Private Person', 'private');
    const id = await essay(
      'A Draft Chapter',
      'Chaired by [[person:a-private-person|the chair]].',
      'private',
    );
    const issued = await share(id);

    const response = await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });

    expect(response.body).toContain('the chair');
    expect(response.body).not.toContain('a-private-person');
    expect(response.body).not.toContain('A Private Person');
  });

  it('does not reach another unpublished essay', async () => {
    const other = await essay('Another Unpublished Chapter', 'Secret.', 'private');
    const id = await essay(
      'A Draft Chapter',
      'See [[essay:another-unpublished-chapter|the other one]].',
      'private',
    );
    const issued = await share(id);

    const response = await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });

    expect(response.body).toContain('the other one');
    expect(response.body).not.toContain('another-unpublished-chapter');
    expect(await findEssayById(harness.pool, other, shareViewer(id))).toBeNull();
  });

  it('does not make the shared chapter reachable at its own URL', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    await share(id);

    const record = await findEssayById(harness.pool, id, adminViewer(harness.userId));
    const response = await harness.app.inject({
      method: 'GET',
      url: `/essays/${record?.slug}`,
    });

    // Issuing a link does not publish anything.
    expect(response.statusCode).toBe(404);
  });

  it('404s once the essay is deleted out from under a live link', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);
    await execute(harness.pool, 'DELETE FROM content_item WHERE id = ?', [id]);

    const response = await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });
    expect(response.statusCode).toBe(404);
  });

  // --- The response --------------------------------------------------------

  it('is never cached, indexed, or allowed to leak the token as a referrer', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);

    const response = await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });

    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-robots-tag']).toContain('noindex');
    // The credential is in the URL, so it must not be handed to anything the
    // page links out to.
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('records that the link was opened', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);

    await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });
    await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });

    const shares = await listShares(harness.pool, id);
    expect(shares[0]?.viewCount).toBe(2);
    expect(shares[0]?.lastViewedAt).toBeInstanceOf(Date);
  });

  // --- Comments ------------------------------------------------------------

  it('accepts a comment anchored to a paragraph', async () => {
    const id = await essay('A Draft Chapter', 'First.\n\nSecond.', 'private');
    const issued = await share(id);

    const page = await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
    const cookies = page.headers['set-cookie'];

    const posted = await harness.app.inject({
      method: 'POST',
      url: `/review/${issued.token}/comments`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: Array.isArray(cookies) ? cookies.join('; ') : (cookies ?? ''),
      },
      payload: new URLSearchParams({
        _csrf: csrf,
        blockIndex: '2',
        body: 'This paragraph needs a source.',
      }).toString(),
    });
    expect(posted.statusCode).toBe(302);

    const comments = await listShareComments(harness.pool, id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      blockIndex: 2,
      body: 'This paragraph needs a source.',
      shareLabel: 'Prof. Ionescu',
    });
  });

  it('refuses a comment without a CSRF token', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);

    const posted = await harness.app.inject({
      method: 'POST',
      url: `/review/${issued.token}/comments`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ body: 'No token.' }).toString(),
    });

    // This route is not exempt from the site-wide rule.
    expect(posted.statusCode).toBe(403);
    expect(await listShareComments(harness.pool, id)).toHaveLength(0);
  });

  it('refuses a comment through a revoked link', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);
    const page = await harness.app.inject({ method: 'GET', url: `/review/${issued.token}` });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
    const cookies = page.headers['set-cookie'];

    await revokeShare(harness.pool, id, issued.share.id);

    const posted = await harness.app.inject({
      method: 'POST',
      url: `/review/${issued.token}/comments`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: Array.isArray(cookies) ? cookies.join('; ') : (cookies ?? ''),
      },
      payload: new URLSearchParams({ _csrf: csrf, body: 'Too late.' }).toString(),
    });

    expect(posted.statusCode).toBe(404);
    expect(await listShareComments(harness.pool, id)).toHaveLength(0);
  });

  it('keeps comments when the link they came through is revoked', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);
    await execute(
      harness.pool,
      `INSERT INTO essay_share_comment (content_item_id, share_id, block_index, body)
       VALUES (?, ?, 1, 'Worth keeping.')`,
      [id, issued.share.id],
    );

    await execute(harness.pool, 'DELETE FROM essay_share WHERE id = ?', [issued.share.id]);

    // Revoking or deleting a link must not delete the feedback it carried.
    const comments = await listShareComments(harness.pool, id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.shareId).toBeNull();
    expect(comments[0]?.body).toBe('Worth keeping.');
  });

  it('marks a comment dealt with and back again', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await share(id);
    await execute(
      harness.pool,
      `INSERT INTO essay_share_comment (content_item_id, share_id, body)
       VALUES (?, ?, 'Needs a source.')`,
      [id, issued.share.id],
    );
    const comment = (await listShareComments(harness.pool, id))[0];

    await setCommentResolved(harness.pool, id, comment?.id ?? 0, true);
    expect((await listShareComments(harness.pool, id))[0]?.resolvedAt).toBeInstanceOf(Date);

    await setCommentResolved(harness.pool, id, comment?.id ?? 0, false);
    expect((await listShareComments(harness.pool, id))[0]?.resolvedAt).toBeNull();
  });

  // --- The admin side ------------------------------------------------------

  it('issues a link from the editor and shows it once', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const page = await getPage(harness, `/admin/essays/${id}/edit`, admin);

    const result = await postForm(harness, `/admin/essays/${id}/shares`, admin, {
      _csrf: page.csrf,
      label: 'Prof. Ionescu',
      expiresInDays: '14',
    });

    expect(result.location).toContain('msg=share_issued');
    expect(result.location).toContain('link=');

    const shares = await listShares(harness.pool, id);
    expect(shares).toHaveLength(1);
    expect(shares[0]?.label).toBe('Prof. Ionescu');
    expect(shares[0]?.state).toBe('live');
  });

  it('needs a session to issue a link', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const result = await postForm(harness, `/admin/essays/${id}/shares`, new Map(), {});

    expect(result.statusCode).toBeGreaterThanOrEqual(300);
    expect(await listShares(harness.pool, id)).toHaveLength(0);
  });

  it('never writes the token into the audit trail', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const page = await getPage(harness, `/admin/essays/${id}/edit`, admin);
    await postForm(harness, `/admin/essays/${id}/shares`, admin, {
      _csrf: page.csrf,
      label: 'Prof. Ionescu',
      expiresInDays: '14',
    });

    const row = await queryOne<RowDataPacket & { detail: string }>(
      harness.pool,
      `SELECT CAST(detail AS CHAR) AS detail FROM audit_log
        WHERE item_id = ? ORDER BY id DESC LIMIT 1`,
      [id],
    );
    expect(row?.detail).toContain('issued');
    expect(row?.detail).toContain('Prof. Ionescu');
    // The label is fine; the credential is not.
    expect(row?.detail).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it('clamps an absurd expiry rather than accepting it', async () => {
    const id = await essay('A Draft Chapter', 'Prose.', 'private');
    const issued = await issueShare(harness.pool, {
      essayId: id,
      label: '',
      expiresInDays: 100_000,
    });

    const days = (issued.share.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(181);
  });
});
