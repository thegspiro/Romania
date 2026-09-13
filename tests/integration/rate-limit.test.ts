/**
 * Rate limiting.
 *
 * Every route that serves a file reads from disk on every request, and the
 * published manuscript download is deliberately `no-store`, so nothing in
 * front of the application absorbs a repeat. The limiter is what bounds that,
 * and it is registered globally rather than per route: a rule attached to
 * three handlers is a rule the fourth has to remember.
 *
 * Two properties are pinned here, and the second is the one that would be
 * expensive to get wrong:
 *
 *  1. An anonymous caller past the limit gets 429 -- as a rendered page, with
 *     `Retry-After`, and never indexed.
 *  2. A signed-in administrator is exempt. That exemption reads
 *     `request.viewer`, which only exists because the plugin is registered
 *     after the hook that sets it. Move the registration earlier and Fastify
 *     runs the limiter first; this suite is what turns that into a failure
 *     rather than an operator silently throttled out of their own editor.
 *
 * Requires MySQL. Without one the suite skips rather than fails; check the
 * output before believing a green run covered this.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieHeader, createHarness, databaseAvailable, signIn, type Harness } from './helpers.js';

const LIMIT = 5;
const available = await databaseAvailable();

describe.skipIf(!available)('rate limiting', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      RATE_LIMIT_MAX: String(LIMIT),
      RATE_LIMIT_WINDOW_SECONDS: '60',
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  /**
   * Drives `count` requests from one address.
   *
   * Every suite here shares a window, so each test uses a distinct source
   * address: the limiter keys on it, and two tests counting into one bucket
   * would pass or fail depending on their order.
   */
  async function burst(
    url: string,
    count: number,
    options: { ip: string; cookie?: string },
  ): Promise<number[]> {
    const codes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const response = await harness.app.inject({
        method: 'GET',
        url,
        remoteAddress: options.ip,
        ...(options.cookie === undefined ? {} : { headers: { cookie: options.cookie } }),
      });
      codes.push(response.statusCode);
    }
    return codes;
  }

  it('answers within the limit and refuses past it', async () => {
    const codes = await burst('/', LIMIT + 2, { ip: '203.0.113.1' });

    expect(codes.slice(0, LIMIT).every((code) => code === 200)).toBe(true);
    expect(codes.slice(LIMIT)).toEqual([429, 429]);
  });

  it('refuses with a rendered page, a Retry-After, and no indexing', async () => {
    await burst('/', LIMIT, { ip: '203.0.113.2' });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '203.0.113.2',
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(response.headers['content-type']).toContain('text/html');
    // The application's own error page, not the plugin's JSON.
    expect(response.body).toContain('<!doctype html>');
    // A refusal must never be indexed, whatever the site setting.
    expect(response.headers['x-robots-tag']).toContain('noindex');

    // And it says the one thing the reader can act on. The generic 4xx branch
    // of the error handler would have called this "Bad request", which is
    // both wrong and no help.
    expect(response.body).toContain('Too many requests');
    expect(response.body).not.toContain('Bad request');
  });

  it('counts each address separately', async () => {
    await burst('/', LIMIT, { ip: '203.0.113.3' });

    // A different reader is unaffected by the first one's burst.
    const other = await harness.app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '203.0.113.4',
    });
    expect(other.statusCode).toBe(200);
  });

  it('exempts a signed-in administrator', async () => {
    // The property that depends on registration order: `allowList` reads
    // request.viewer, which the onRequest hook sets before the limiter runs.
    const jar = await signIn(harness);
    const codes = await burst('/admin', LIMIT * 3, {
      ip: '203.0.113.5',
      cookie: cookieHeader(jar),
    });

    expect(codes.every((code) => code === 200)).toBe(true);
  });

  it('still limits an anonymous caller from the address an admin used', async () => {
    // The exemption is the viewer's, not the address's: signing in must not
    // leave a hole that an unauthenticated request from the same address can
    // walk through.
    const codes = await burst('/', LIMIT + 1, { ip: '203.0.113.5' });
    expect(codes.at(-1)).toBe(429);
  });

  it('never throttles the container healthcheck', async () => {
    // Throttling it would mark the service unhealthy and restart it, turning
    // a burst of reader traffic into an outage.
    const codes = await burst('/healthz', LIMIT * 3, { ip: '203.0.113.6' });
    expect(codes.every((code) => code === 200)).toBe(true);
  });

  it('limits the file route, which is the reason this exists', async () => {
    // Unknown ids, so every one of these 404s -- the point is that the
    // limiter counts them before the handler touches the disk.
    const codes = await burst('/files/999999/original', LIMIT + 1, { ip: '203.0.113.7' });
    expect(codes.slice(0, LIMIT).every((code) => code === 404)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});
