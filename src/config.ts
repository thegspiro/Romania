/**
 * Configuration loading and validation.
 *
 * Every setting comes from the environment. The process refuses to start when
 * a value is missing or malformed rather than falling back to a default that
 * might be unsafe -- an internet-facing service that silently starts with
 * insecure cookies or an unset WebAuthn origin is worse than one that does not
 * start at all.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type EnvSource = Record<string, string | undefined>;

/** Reads a variable, treating whitespace-only values as absent. */
function read(env: EnvSource, name: string, fallback?: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

/**
 * Resolves a secret from either NAME or NAME_FILE.
 *
 * The _FILE form is how Docker Swarm, Kubernetes and Unraid secret mounts
 * deliver credentials without putting them in the process environment, where
 * they would show up in `docker inspect` and crash dumps.
 */
function readSecret(env: EnvSource, name: string): string | undefined {
  const direct = read(env, name);
  const fromFile = read(env, `${name}_FILE`);

  if (direct !== undefined && fromFile !== undefined) {
    throw new ConfigError(`Set either ${name} or ${name}_FILE, not both.`);
  }
  if (fromFile === undefined) return direct;

  try {
    const contents = readFileSync(fromFile, 'utf8').trim();
    if (contents === '') {
      throw new ConfigError(`${name}_FILE points at ${fromFile}, which is empty.`);
    }
    return contents;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot read ${name}_FILE at ${fromFile}: ${reason}`);
  }
}

const BooleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes' || value === 'on');

const IntegerString = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

/** An absolute http(s) URL with no path, query or fragment. */
const OriginString = z.string().refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  );
}, 'must be an absolute http(s) origin such as https://example.org (no trailing path)');

/**
 * The secrets `.env.example` ships. They exist to be replaced, and they are
 * published in this repository, so a deployment still carrying one has a
 * database password that anybody can read. Checked only in production: the
 * development and test paths copy `.env.example` verbatim on purpose.
 */
const PLACEHOLDER_SECRETS = new Set(['change-me', 'change-me-too']);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),

  HTTP_HOST: z.string().min(1),
  HTTP_PORT: IntegerString(1, 65535),
  PUBLIC_BASE_URL: OriginString,
  TRUST_PROXY: BooleanString,

  DB_HOST: z.string().min(1),
  DB_PORT: IntegerString(1, 65535),
  DB_NAME: z.string().min(1).max(64),
  DB_USER: z.string().min(1).max(64),
  DB_PASSWORD: z.string().min(1),
  DB_CONNECTION_LIMIT: IntegerString(1, 100),

  SESSION_TTL_HOURS: IntegerString(1, 8760),
  SESSION_SECURE_COOKIES: BooleanString,

  // A bare registrable domain: no scheme, no port, no path. Browsers compare
  // this against the origin's effective domain on every ceremony.
  WEBAUTHN_RP_ID: z
    .string()
    .min(1)
    .regex(
      /^(localhost|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i,
      'must be a bare domain such as example.org or "localhost" (no scheme, port or path)',
    ),
  WEBAUTHN_RP_NAME: z.string().min(1).max(190),
  WEBAUTHN_ORIGINS: z.array(OriginString).min(1),

  ARGON2_MEMORY_KIB: IntegerString(8192, 1_048_576),
  ARGON2_TIME_COST: IntegerString(1, 20),
  ARGON2_PARALLELISM: IntegerString(1, 16),

  LOGIN_MAX_ATTEMPTS: IntegerString(1, 1000),
  LOGIN_WINDOW_MINUTES: IntegerString(1, 1440),
  LOGIN_LOCKOUT_MINUTES: IntegerString(1, 1440),

  STORAGE_ROOT: z.string().min(1),
  UPLOAD_MAX_BYTES: IntegerString(1, 10_737_418_240),

  ALLOW_SEARCH_INDEXING: BooleanString,

  // The web service enqueues a Zotero sync but never calls the API itself, so
  // it needs to know which library is configured and nothing more. The API key
  // is read by the worker alone -- there is no reason for the process facing
  // the internet to hold a credential it cannot use.
  ZOTERO_LIBRARY_TYPE: z.enum(['user', 'group']),
  ZOTERO_LIBRARY_ID: z
    .string()
    .regex(/^\d+$/, 'must be the numeric library id shown on zotero.org')
    .optional(),
});

export type Config = Readonly<
  z.infer<typeof schema> & {
    /**
     * Name of the session cookie. The `__Host-` prefix is applied only with
     * secure cookies, because browsers reject that prefix without the Secure
     * attribute -- which would make the app unusable over plain HTTP in
     * development.
     */
    sessionCookieName: string;
    sessionTtlMs: number;
  }
>;

export function loadConfig(env: EnvSource = process.env): Config {
  const originsRaw = read(env, 'WEBAUTHN_ORIGIN');

  const candidate = {
    NODE_ENV: read(env, 'NODE_ENV', 'production'),
    LOG_LEVEL: read(env, 'LOG_LEVEL', 'info'),

    HTTP_HOST: read(env, 'HTTP_HOST', '0.0.0.0'),
    HTTP_PORT: read(env, 'HTTP_PORT', '8080'),
    PUBLIC_BASE_URL: read(env, 'PUBLIC_BASE_URL', 'http://localhost:8080'),
    TRUST_PROXY: read(env, 'TRUST_PROXY', 'false'),

    DB_HOST: read(env, 'DB_HOST', 'db'),
    DB_PORT: read(env, 'DB_PORT', '3306'),
    DB_NAME: read(env, 'DB_NAME', 'dissertation'),
    DB_USER: read(env, 'DB_USER', 'dissertation'),
    DB_PASSWORD: readSecret(env, 'DB_PASSWORD'),
    DB_CONNECTION_LIMIT: read(env, 'DB_CONNECTION_LIMIT', '10'),

    SESSION_TTL_HOURS: read(env, 'SESSION_TTL_HOURS', '720'),
    SESSION_SECURE_COOKIES: read(env, 'SESSION_SECURE_COOKIES', 'true'),

    WEBAUTHN_RP_ID: read(env, 'WEBAUTHN_RP_ID'),
    WEBAUTHN_RP_NAME: read(env, 'WEBAUTHN_RP_NAME', 'Dissertation Platform'),
    WEBAUTHN_ORIGINS:
      originsRaw === undefined
        ? undefined
        : originsRaw
            .split(',')
            .map((origin) => origin.trim())
            .filter((origin) => origin !== ''),

    ARGON2_MEMORY_KIB: read(env, 'ARGON2_MEMORY_KIB', '65536'),
    ARGON2_TIME_COST: read(env, 'ARGON2_TIME_COST', '3'),
    ARGON2_PARALLELISM: read(env, 'ARGON2_PARALLELISM', '1'),

    LOGIN_MAX_ATTEMPTS: read(env, 'LOGIN_MAX_ATTEMPTS', '10'),
    LOGIN_WINDOW_MINUTES: read(env, 'LOGIN_WINDOW_MINUTES', '15'),
    LOGIN_LOCKOUT_MINUTES: read(env, 'LOGIN_LOCKOUT_MINUTES', '15'),

    STORAGE_ROOT: read(env, 'STORAGE_ROOT', '/data/files'),
    UPLOAD_MAX_BYTES: read(env, 'UPLOAD_MAX_BYTES', '209715200'),

    ALLOW_SEARCH_INDEXING: read(env, 'ALLOW_SEARCH_INDEXING', 'false'),

    ZOTERO_LIBRARY_TYPE: read(env, 'ZOTERO_LIBRARY_TYPE', 'user'),
    ZOTERO_LIBRARY_ID: read(env, 'ZOTERO_LIBRARY_ID'),
  };

  const result = schema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }

  const parsed = result.data;

  // Cross-field checks that a per-field schema cannot express.
  if (parsed.NODE_ENV === 'production' && !parsed.SESSION_SECURE_COOKIES) {
    throw new ConfigError(
      'SESSION_SECURE_COOKIES must be true in production: without it the session ' +
        'cookie is sent over plain HTTP and can be captured in transit.',
    );
  }

  if (parsed.NODE_ENV === 'production' && PLACEHOLDER_SECRETS.has(parsed.DB_PASSWORD)) {
    throw new ConfigError(
      `DB_PASSWORD is still the placeholder "${parsed.DB_PASSWORD}" from .env.example. ` +
        'That value is published in this repository, so the database is effectively ' +
        'unprotected. Generate one instead, for example `openssl rand -base64 24`.',
    );
  }

  for (const origin of parsed.WEBAUTHN_ORIGINS) {
    const host = new URL(origin).hostname;
    const matchesRpId =
      host === parsed.WEBAUTHN_RP_ID || host.endsWith(`.${parsed.WEBAUTHN_RP_ID}`);
    if (!matchesRpId) {
      throw new ConfigError(
        `WEBAUTHN_ORIGIN "${origin}" is not valid for WEBAUTHN_RP_ID ` +
          `"${parsed.WEBAUTHN_RP_ID}". The origin's host must equal the RP ID or be a ` +
          'subdomain of it, or the browser will reject every passkey ceremony.',
      );
    }
  }

  return Object.freeze({
    ...parsed,
    sessionCookieName: parsed.SESSION_SECURE_COOKIES ? '__Host-dsp_session' : 'dsp_session',
    sessionTtlMs: parsed.SESSION_TTL_HOURS * 60 * 60 * 1000,
  });
}
