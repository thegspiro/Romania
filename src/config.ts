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
 * A slippy-map tile template, such as `https://tiles.example.org/{z}/{x}/{y}.png`.
 *
 * Empty means no basemap, which is the default and the private option: markers
 * are drawn on a plain canvas and the browser contacts nobody but this server.
 * Setting it is a deliberate trade -- tile URLs encode the coordinates and zoom
 * level being looked at, so the tile host learns which places are being read,
 * including the private ones an administrator is reviewing.
 *
 * A `{s}` subdomain placeholder is rejected rather than supported. The host has
 * to be a literal so that exactly one origin can be added to `img-src`; a
 * pattern there would either widen the policy to a wildcard or produce a source
 * the browser silently ignores. Subdomain sharding buys nothing over HTTP/2.
 */
const TileUrlString = z.string().refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.hostname.includes('{') || url.hostname.includes('}')) return false;
  return value.includes('{z}') && value.includes('{x}') && value.includes('{y}');
}, 'must be an http(s) tile template containing {z}, {x} and {y}, with a literal host (no {s} placeholder)');

/**
 * The secrets `.env.example` ships. They exist to be replaced, and they are
 * published in this repository, so a deployment still carrying one has a
 * database password that anybody can read. Checked only in production: the
 * development and test paths copy `.env.example` verbatim on purpose.
 */
const PLACEHOLDER_SECRETS = new Set(['change-me', 'change-me-too']);

/**
 * Whether a host is the relying party or sits below it.
 *
 * This is the browser's own rule for a passkey ceremony, and it now governs
 * two values, so it lives in one place: an origin that fails it is rejected
 * by the browser, and a PUBLIC_BASE_URL that fails it sends visitors to a
 * host where no ceremony can succeed.
 */
function isWithinRelyingParty(host: string, rpId: string): boolean {
  return host === rpId || host.endsWith(`.${rpId}`);
}

const schema = z
  .object({
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
    // The message describes what the operator types -- one variable holding a
    // comma-separated list -- rather than the array it parses into. "Expected
    // array" is true of the schema and useless to the person reading it.
    WEBAUTHN_ORIGINS: z
      .array(OriginString, { error: 'is required: one or more origins, comma-separated' })
      .min(1, 'must list at least one origin'),

    ARGON2_MEMORY_KIB: IntegerString(8192, 1_048_576),
    ARGON2_TIME_COST: IntegerString(1, 20),
    ARGON2_PARALLELISM: IntegerString(1, 16),

    LOGIN_MAX_ATTEMPTS: IntegerString(1, 1000),
    LOGIN_WINDOW_MINUTES: IntegerString(1, 1440),
    LOGIN_LOCKOUT_MINUTES: IntegerString(1, 1440),

    // Requests per window per address, for anonymous traffic. Deliberately
    // generous: the limit exists to stop one address doing unbounded work --
    // every file route reads from disk on every request -- not to ration
    // reading. See the note in http/server.ts about what the address means
    // when TRUST_PROXY is off.
    RATE_LIMIT_MAX: IntegerString(1, 1_000_000),
    RATE_LIMIT_WINDOW_SECONDS: IntegerString(1, 3600),

    STORAGE_ROOT: z.string().min(1),
    UPLOAD_MAX_BYTES: IntegerString(1, 10_737_418_240),

    // Where file bytes live. `local` is the default and changes nothing for an
    // existing install; `s3` puts them in an object store. Storage keys are
    // identical either way -- the database, the URLs and the reference syntax
    // are backend-independent -- so switching is this value plus
    // `admin storage migrate`, never a schema change.
    //
    // STORAGE_ROOT stays required under `s3`: uploads are hashed into a local
    // scratch file before they can be addressed, and the worker needs
    // somewhere to put a file Pandoc can read.
    STORAGE_BACKEND: z.enum(['local', 's3']),
    S3_BUCKET: z.string().max(255),
    S3_REGION: z.string().max(64),
    // Set for anything that is not AWS -- MinIO, Backblaze B2, Wasabi, Ceph.
    S3_ENDPOINT: z.union([z.literal(''), OriginString]),
    S3_FORCE_PATH_STYLE: BooleanString,
    S3_PREFIX: z.string().max(190),
    // Left empty on AWS so the SDK's own chain finds an instance role, which
    // is better than a long-lived key this application would have to hold.
    S3_ACCESS_KEY_ID: z.string().max(255),
    S3_SECRET_ACCESS_KEY: z.string().max(255),

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

    // Unset by default, and the maps work without it. See TileUrlString above
    // for what setting it discloses.
    MAP_TILE_URL: TileUrlString.optional(),
    MAP_TILE_ATTRIBUTION: z.string().max(500).optional(),
  })
  .superRefine((value, context) => {
    // Every tile provider worth using requires credit, and the attribution has
    // to be configured alongside the URL rather than hard-coded, because the
    // right wording depends on whose tiles they are.
    if (value.MAP_TILE_URL !== undefined && (value.MAP_TILE_ATTRIBUTION ?? '').trim() === '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAP_TILE_ATTRIBUTION'],
        message: 'is required when MAP_TILE_URL is set, to credit the tile provider',
      });
    }

    // A bucket is the one thing the S3 backend cannot be given a default for.
    // Refusing at startup is the point of validating here at all: the
    // alternative is a service that starts, accepts an upload, and fails on
    // the first byte it tries to store.
    if (value.STORAGE_BACKEND === 's3' && value.S3_BUCKET.trim() === '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_BUCKET'],
        message: 'is required when STORAGE_BACKEND is s3',
      });
    }

    // Half a key pair is a misconfiguration that presents as a permission
    // error much later. Neither is fine -- the SDK then looks for an instance
    // role, which is the better arrangement on AWS.
    const hasId = value.S3_ACCESS_KEY_ID.trim() !== '';
    const hasSecret = value.S3_SECRET_ACCESS_KEY.trim() !== '';
    if (hasId !== hasSecret) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_SECRET_ACCESS_KEY'],
        message:
          'set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither ' +
          '(neither lets the AWS SDK use an instance or container role)',
      });
    }
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

/**
 * Schema fields whose environment variable is spelled differently.
 *
 * The schema names the parsed value; the operator sets the variable. They are
 * the same everywhere but here: one `WEBAUTHN_ORIGIN` holding a
 * comma-separated list becomes the `WEBAUTHN_ORIGINS` array. Reporting the
 * field name sent the operator looking for a variable that does not exist,
 * which is the worst moment to be given a wrong name -- the service is
 * refusing to start, and a first deployment has nothing else to go on.
 */
const ENV_NAMES: Readonly<Record<string, string>> = Object.freeze({
  WEBAUTHN_ORIGINS: 'WEBAUTHN_ORIGIN',
});

/**
 * How one validation failure is addressed to the person who can fix it.
 *
 * Substitution is on the head of the path only, so a failure *inside* a parsed
 * array still names the variable and keeps the index: an unusable entry in
 * WEBAUTHN_ORIGIN reads as `WEBAUTHN_ORIGIN.1`, which points at the second
 * item of the list they actually wrote.
 */
function issueLabel(path: readonly PropertyKey[]): string {
  const segments = path.map(String);
  const [head, ...rest] = segments;
  if (head === undefined) return '(root)';
  return [ENV_NAMES[head] ?? head, ...rest].join('.');
}

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

    RATE_LIMIT_MAX: read(env, 'RATE_LIMIT_MAX', '300'),
    RATE_LIMIT_WINDOW_SECONDS: read(env, 'RATE_LIMIT_WINDOW_SECONDS', '60'),

    STORAGE_ROOT: read(env, 'STORAGE_ROOT', '/data/files'),
    UPLOAD_MAX_BYTES: read(env, 'UPLOAD_MAX_BYTES', '209715200'),

    STORAGE_BACKEND: read(env, 'STORAGE_BACKEND', 'local'),
    S3_BUCKET: read(env, 'S3_BUCKET', ''),
    S3_REGION: read(env, 'S3_REGION', 'us-east-1'),
    S3_ENDPOINT: read(env, 'S3_ENDPOINT', ''),
    // Path style is wrong on AWS and right almost everywhere else, so it
    // follows whether an endpoint was given rather than being guessed here.
    S3_FORCE_PATH_STYLE: read(
      env,
      'S3_FORCE_PATH_STYLE',
      read(env, 'S3_ENDPOINT', '') === '' ? 'false' : 'true',
    ),
    S3_PREFIX: read(env, 'S3_PREFIX', ''),
    S3_ACCESS_KEY_ID: read(env, 'S3_ACCESS_KEY_ID', ''),
    S3_SECRET_ACCESS_KEY: readSecret(env, 'S3_SECRET_ACCESS_KEY') ?? '',

    ALLOW_SEARCH_INDEXING: read(env, 'ALLOW_SEARCH_INDEXING', 'false'),

    ZOTERO_LIBRARY_TYPE: read(env, 'ZOTERO_LIBRARY_TYPE', 'user'),
    ZOTERO_LIBRARY_ID: read(env, 'ZOTERO_LIBRARY_ID'),

    MAP_TILE_URL: read(env, 'MAP_TILE_URL'),
    MAP_TILE_ATTRIBUTION: read(env, 'MAP_TILE_ATTRIBUTION'),
  };

  const result = schema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issueLabel(issue.path)}: ${issue.message}`)
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
    if (!isWithinRelyingParty(host, parsed.WEBAUTHN_RP_ID)) {
      throw new ConfigError(
        `WEBAUTHN_ORIGIN "${origin}" is not valid for WEBAUTHN_RP_ID ` +
          `"${parsed.WEBAUTHN_RP_ID}". The origin's host must equal the RP ID or be a ` +
          'subdomain of it, or the browser will reject every passkey ceremony.',
      );
    }
  }

  // PUBLIC_BASE_URL builds every absolute link and validates redirects. Left
  // pointing at a host the relying party does not cover, the site comes up,
  // serves pages and then fails at the login form -- the one screen the
  // operator reaches last. The origins above are already checked against the
  // RP ID; this closes the gap where the canonical URL is not one of them.
  const baseUrlHost = new URL(parsed.PUBLIC_BASE_URL).hostname;
  if (!isWithinRelyingParty(baseUrlHost, parsed.WEBAUTHN_RP_ID)) {
    throw new ConfigError(
      `PUBLIC_BASE_URL "${parsed.PUBLIC_BASE_URL}" is not valid for WEBAUTHN_RP_ID ` +
        `"${parsed.WEBAUTHN_RP_ID}". Its host must equal the RP ID or be a subdomain ` +
        'of it, or visitors will be sent to a host where no passkey can be used.',
    );
  }

  return Object.freeze({
    ...parsed,
    sessionCookieName: parsed.SESSION_SECURE_COOKIES ? '__Host-dsp_session' : 'dsp_session',
    sessionTtlMs: parsed.SESSION_TTL_HOURS * 60 * 60 * 1000,
  });
}
