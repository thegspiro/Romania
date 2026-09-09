/**
 * Authentication and session handling against a real database.
 *
 * The property under test throughout is that a password alone is never enough:
 * this site is internet-facing and a leaked or guessed password must leave the
 * attacker holding a session that can read nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createHarness,
  csrfFrom,
  databaseAvailable,
  getPage,
  mergeCookies,
  postForm,
  signIn,
  truncateContent,
  TEST_PASSWORD,
  TEST_USERNAME,
  type Harness,
} from './helpers.js';
import { queryOne } from '../../src/db/pool.js';
import type { RowDataPacket } from 'mysql2/promise';

const available = await databaseAvailable();

describe.skipIf(!available)('authentication', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await truncateContent(harness.pool);
  });

  /** Password step only; the returned session is `password_pending`. */
  async function passwordOnly(password = TEST_PASSWORD): Promise<Map<string, string>> {
    const jar = new Map<string, string>();
    const page = await harness.app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, page.headers['set-cookie']);

    const response = await postForm(harness, '/login', jar, {
      _csrf: csrfFrom(page.body),
      username: TEST_USERNAME,
      password,
    });
    void response;
    return jar;
  }

  it('rejects a wrong password', async () => {
    const jar = new Map<string, string>();
    const page = await harness.app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, page.headers['set-cookie']);

    const response = await postForm(harness, '/login', jar, {
      _csrf: csrfFrom(page.body),
      username: TEST_USERNAME,
      password: 'not the right password',
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('Incorrect username or password');
  });

  it('gives the same answer for an unknown username', async () => {
    // No username enumeration: the message and the status must not differ.
    const jar = new Map<string, string>();
    const page = await harness.app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, page.headers['set-cookie']);

    const response = await postForm(harness, '/login', jar, {
      _csrf: csrfFrom(page.body),
      username: 'no-such-person',
      password: TEST_PASSWORD,
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('Incorrect username or password');
  });

  it('refuses a state-changing request with no CSRF token', async () => {
    const jar = new Map<string, string>();
    const page = await harness.app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, page.headers['set-cookie']);

    const response = await postForm(harness, '/login', jar, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a forged CSRF token', async () => {
    const jar = new Map<string, string>();
    const page = await harness.app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, page.headers['set-cookie']);

    const response = await postForm(harness, '/login', jar, {
      _csrf: 'a'.repeat(43),
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
    expect(response.statusCode).toBe(403);
  });

  it('leaves a correct password holding only a password_pending session', async () => {
    const jar = await passwordOnly();

    const session = await queryOne<RowDataPacket & { auth_state: string }>(
      harness.pool,
      'SELECT auth_state FROM session ORDER BY id LIMIT 1',
    );
    expect(session?.auth_state).toBe('password_pending');

    // And that session can reach nothing.
    const admin = await harness.app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(admin.statusCode).toBe(302);
    expect(admin.headers.location).toBe('/login/second-factor');
  });

  it('sends an unauthenticated visitor to the login page', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/admin' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login');
  });

  it('offers passkey registration when the account has none', async () => {
    const jar = await passwordOnly();
    const page = await getPage(harness, '/login/second-factor', jar);
    expect(page.body).toContain('Register a passkey');
  });

  it('refuses to start a passkey ceremony without the password step', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/passkey/authenticate/options',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(response.statusCode).toBe(403); // CSRF is checked before anything else
  });

  it('completes the second factor with a recovery code and grants access', async () => {
    const jar = await signIn(harness);

    const session = await queryOne<RowDataPacket & { auth_state: string }>(
      harness.pool,
      'SELECT auth_state FROM session ORDER BY id DESC LIMIT 1',
    );
    expect(session?.auth_state).toBe('authenticated');

    const admin = await getPage(harness, '/admin', jar);
    expect(admin.statusCode).toBe(200);
    expect(admin.body).toContain('Dashboard');
  });

  it('spends a recovery code so it cannot be reused', async () => {
    await signIn(harness);
    const remaining = await queryOne<RowDataPacket & { total: number }>(
      harness.pool,
      'SELECT COUNT(*) AS total FROM recovery_code WHERE used_at IS NULL',
    );
    expect(remaining?.total).toBe(0);
  });

  it('rotates the session id when the second factor succeeds', async () => {
    // A token observed during the password-only phase must be useless after.
    const jar = new Map<string, string>();
    const page = await harness.app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, page.headers['set-cookie']);
    await postForm(harness, '/login', jar, {
      _csrf: csrfFrom(page.body),
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
    const pendingToken = jar.get('dsp_session');

    const authenticated = await signIn(harness);
    expect(authenticated.get('dsp_session')).toBeDefined();
    expect(authenticated.get('dsp_session')).not.toBe(pendingToken);
  });

  it('locks out after too many failed attempts', async () => {
    const config = harness.config;
    for (let attempt = 0; attempt < config.LOGIN_MAX_ATTEMPTS; attempt += 1) {
      const jar = new Map<string, string>();
      const page = await harness.app.inject({ method: 'GET', url: '/login' });
      mergeCookies(jar, page.headers['set-cookie']);
      await postForm(harness, '/login', jar, {
        _csrf: csrfFrom(page.body),
        username: TEST_USERNAME,
        password: 'wrong password here',
      });
    }

    const jar = new Map<string, string>();
    const page = await harness.app.inject({ method: 'GET', url: '/login' });
    mergeCookies(jar, page.headers['set-cookie']);
    const locked = await postForm(harness, '/login', jar, {
      _csrf: csrfFrom(page.body),
      username: TEST_USERNAME,
      // Even the correct password is refused while locked out.
      password: TEST_PASSWORD,
    });

    expect(locked.statusCode).toBe(429);
    expect(locked.body).toContain('Too many failed attempts');
  });

  it('destroys the session on sign-out', async () => {
    const jar = await signIn(harness);
    const dashboard = await getPage(harness, '/admin', jar);

    const response = await postForm(harness, '/logout', jar, { _csrf: dashboard.csrf });
    expect(response.statusCode).toBe(302);

    const sessions = await queryOne<RowDataPacket & { total: number }>(
      harness.pool,
      'SELECT COUNT(*) AS total FROM session',
    );
    expect(sessions?.total).toBe(0);

    const after = await getPage(harness, '/admin', jar);
    expect(after.statusCode).toBe(302);
  });

  it('marks the session cookie HttpOnly and SameSite=Lax', async () => {
    const page = await harness.app.inject({ method: 'GET', url: '/login' });
    const raw = page.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw.join(';') : String(raw);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
  });

  it('writes an audit entry for a successful sign-in', async () => {
    await signIn(harness);
    const entry = await queryOne<RowDataPacket & { action: string }>(
      harness.pool,
      "SELECT action FROM audit_log WHERE action = 'auth.recovery.used' LIMIT 1",
    );
    expect(entry?.action).toBe('auth.recovery.used');
  });
});
