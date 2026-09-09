/**
 * Integration test harness.
 *
 * These tests run against a real MySQL 8 server, not a mock. The whole point
 * of them is to prove that the SQL, the schema constraints and the visibility
 * filter behave as intended, and a fake would prove none of it.
 *
 * Point them at a database with:
 *
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3306 TEST_DB_NAME=dissertation_test \
 *   TEST_DB_USER=dissertation TEST_DB_PASSWORD=... npm test
 *
 * When no database is reachable the integration suites skip with a message
 * rather than failing, so `npm test` still runs the unit suites on a machine
 * that has no MySQL.
 *
 * WARNING: the harness drops every table in the target database. Never point
 * it at anything but a disposable test database.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, execute, type Pool } from '../../src/db/pool.js';
import { migrateDown, migrateUp } from '../../src/db/migrate.js';
import { buildServer } from '../../src/http/server.js';
import { createUser } from '../../src/auth/repository.js';
import { hashPassword } from '../../src/auth/password.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

export const TEST_PASSWORD = 'integration-test-password';
export const TEST_USERNAME = 'tester';

/** Cheap Argon2 parameters: these suites hash many times. */
const TEST_ARGON2 = { ARGON2_MEMORY_KIB: '8192', ARGON2_TIME_COST: '1', ARGON2_PARALLELISM: '1' };

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME ?? 'dissertation_test',
    DB_USER: process.env.TEST_DB_USER ?? 'dissertation',
    DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? 'testpass',
    PUBLIC_BASE_URL: 'http://localhost:8080',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGIN: 'http://localhost:8080',
    SESSION_SECURE_COOKIES: 'false',
    ALLOW_SEARCH_INDEXING: 'false',
    STORAGE_ROOT: '/tmp/dissertation-test-files',
    ...TEST_ARGON2,
    ...overrides,
  });
}

/** True when a MySQL server is reachable with the test credentials. */
export async function databaseAvailable(): Promise<boolean> {
  let pool: Pool | undefined;
  try {
    pool = createPool(testConfig());
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool?.end();
  }
}

export interface Harness {
  config: Config;
  pool: Pool;
  app: FastifyInstance;
  userId: number;
  close: () => Promise<void>;
}

/** Migrates the test database from empty and starts the application. */
export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const config = testConfig(overrides);

  // Start from nothing, so a suite never inherits another run's schema.
  await migrateDown(0, { config, directory: MIGRATIONS_DIR });
  await migrateUp({ config, directory: MIGRATIONS_DIR });

  const pool = createPool(config);
  const app = await buildServer({ config, pool });
  await app.ready();

  const userId = await createUser(pool, {
    username: TEST_USERNAME,
    displayName: 'Test Operator',
    passwordHash: await hashPassword(TEST_PASSWORD, {
      memoryCost: config.ARGON2_MEMORY_KIB,
      timeCost: config.ARGON2_TIME_COST,
      parallelism: config.ARGON2_PARALLELISM,
    }),
  });

  return {
    config,
    pool,
    app,
    userId,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/** Empties the content tables between tests, leaving the account in place. */
export async function truncateContent(pool: Pool): Promise<void> {
  await execute(pool, 'SET FOREIGN_KEY_CHECKS = 0');
  for (const table of [
    'manuscript_build',
    'manuscript_section',
    'manuscript_detail',
    'mention',
    'citation',
    'relationship',
    'content_tag',
    'tag',
    'source_detail',
    'artifact_detail',
    'essay_detail',
    'agent_detail',
    'place_detail',
    'event_detail',
    'file_derivative',
    'file_object',
    'content_item',
    'audit_log',
    'job',
    'login_attempt',
    'session',
  ]) {
    await execute(pool, `TRUNCATE TABLE ${table}`);
  }
  await execute(pool, 'SET FOREIGN_KEY_CHECKS = 1');
}

// --- HTTP helpers ----------------------------------------------------------

/** Parses Set-Cookie headers into a name -> value map. */
export function readCookies(raw: string | string[] | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  const headers = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  for (const header of headers) {
    const [pair] = header.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair === undefined || index === -1) continue;
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return cookies;
}

export function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function mergeCookies(jar: Map<string, string>, raw: string | string[] | undefined): void {
  for (const [name, value] of readCookies(raw)) {
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

/** Pulls the CSRF token out of a rendered form. */
export function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  if (match?.[1] === undefined) {
    throw new Error('no CSRF token found in the response body');
  }
  return match[1];
}

/**
 * Signs in far enough to hold an authenticated session.
 *
 * The second factor is completed with a recovery code: a WebAuthn ceremony
 * needs an authenticator, which a server-side test does not have. The passkey
 * path itself is covered by the unit tests over `src/auth/webauthn.ts` and by
 * the manual check documented in README.md.
 */
export async function signIn(harness: Harness): Promise<Map<string, string>> {
  const { app, pool, config, userId } = harness;
  const jar = new Map<string, string>();

  const loginPage = await app.inject({ method: 'GET', url: '/login' });
  mergeCookies(jar, loginPage.headers['set-cookie']);

  const password = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      _csrf: csrfFrom(loginPage.body),
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    }).toString(),
  });
  mergeCookies(jar, password.headers['set-cookie']);

  // Issue a recovery code directly, rather than driving the UI for it.
  const { generateRecoveryCode, hashRecoveryCode } = await import('../../src/auth/recovery.js');
  const { replaceRecoveryCodes } = await import('../../src/auth/repository.js');
  const code = generateRecoveryCode();
  await replaceRecoveryCodes(pool, userId, [
    await hashRecoveryCode(code, {
      memoryCost: config.ARGON2_MEMORY_KIB,
      timeCost: config.ARGON2_TIME_COST,
      parallelism: config.ARGON2_PARALLELISM,
    }),
  ]);

  const recoveryPage = await app.inject({
    method: 'GET',
    url: '/login/recovery',
    headers: { cookie: cookieHeader(jar) },
  });
  mergeCookies(jar, recoveryPage.headers['set-cookie']);

  const recovery = await app.inject({
    method: 'POST',
    url: '/login/recovery',
    headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ _csrf: csrfFrom(recoveryPage.body), code }).toString(),
  });
  mergeCookies(jar, recovery.headers['set-cookie']);

  if (recovery.statusCode !== 302) {
    throw new Error(`recovery sign-in failed with ${recovery.statusCode}`);
  }
  return jar;
}

/** Fetches a page and returns its body plus a usable CSRF token. */
export async function getPage(
  harness: Harness,
  url: string,
  jar: Map<string, string>,
): Promise<{ body: string; statusCode: number; csrf: string }> {
  const response = await harness.app.inject({
    method: 'GET',
    url,
    headers: { cookie: cookieHeader(jar) },
  });
  mergeCookies(jar, response.headers['set-cookie']);
  return {
    body: response.body,
    statusCode: response.statusCode,
    csrf: response.body.includes('name="_csrf"') ? csrfFrom(response.body) : '',
  };
}

export async function postForm(
  harness: Harness,
  url: string,
  jar: Map<string, string>,
  fields: Record<string, string>,
): Promise<{ statusCode: number; body: string; location: string | undefined }> {
  const response = await harness.app.inject({
    method: 'POST',
    url,
    headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
  mergeCookies(jar, response.headers['set-cookie']);
  return {
    statusCode: response.statusCode,
    body: response.body,
    location: response.headers.location,
  };
}

/** The minimum a source form needs; every field is a string, as HTML posts them. */
export function sourceForm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    title: 'A Test Source',
    cslType: 'book',
    titleOriginal: '',
    summary: '',
    language: '',
    visibility: 'private',
    authors: '',
    editors: '',
    translators: '',
    containerTitle: '',
    collectionTitle: '',
    publisher: '',
    publisherPlace: '',
    volume: '',
    issue: '',
    page: '',
    edition: '',
    genre: '',
    medium: '',
    issued: '',
    accessed: '',
    archive: '',
    archiveLocation: '',
    callNumber: '',
    url: '',
    doi: '',
    isbn: '',
    note: '',
    ...overrides,
  };
}
