/**
 * Configuration validation.
 *
 * These cases are the reason `loadConfig` refuses to fall back to a default:
 * each one is a misconfiguration that would otherwise produce a running,
 * internet-facing service that is quietly insecure or quietly broken.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    DB_PASSWORD: 'secret',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGIN: 'http://localhost:8080',
    PUBLIC_BASE_URL: 'http://localhost:8080',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('loads a valid configuration and derives session values', () => {
    const config = loadConfig(env());
    expect(config.HTTP_PORT).toBe(8080);
    expect(config.WEBAUTHN_ORIGINS).toEqual(['http://localhost:8080']);
    expect(config.sessionTtlMs).toBe(720 * 60 * 60 * 1000);
  });

  it('requires a database password', () => {
    expect(() => loadConfig(env({ DB_PASSWORD: undefined }))).toThrow(ConfigError);
  });

  it('defaults the rate limit to something a page load cannot trip', () => {
    // A page pulls its vendored CSS, JS and any images, so a limit near that
    // number would refuse ordinary reading rather than bound the file routes.
    const config = loadConfig(env());
    expect(config.RATE_LIMIT_MAX).toBe(300);
    expect(config.RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it('rejects a rate limit of zero rather than reading it as "off"', () => {
    // Zero would be indistinguishable from a typo, and a limiter that refuses
    // every request is worse than none at all. Turning it off is raising it.
    expect(() => loadConfig(env({ RATE_LIMIT_MAX: '0' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ RATE_LIMIT_WINDOW_SECONDS: '0' }))).toThrow(ConfigError);
  });

  it('refuses both DB_PASSWORD and DB_PASSWORD_FILE', () => {
    expect(() => loadConfig(env({ DB_PASSWORD_FILE: '/run/secrets/db' }))).toThrow(/not both/);
  });

  it('rejects a WebAuthn RP ID that carries a scheme or port', () => {
    // A browser compares the RP ID against the origin's effective domain; a
    // URL here fails every ceremony with an opaque error.
    expect(() => loadConfig(env({ WEBAUTHN_RP_ID: 'https://example.org' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ WEBAUTHN_RP_ID: 'example.org:8080' }))).toThrow(ConfigError);
  });

  it('rejects an origin that does not match the RP ID', () => {
    expect(() =>
      loadConfig(
        env({
          WEBAUTHN_RP_ID: 'example.org',
          WEBAUTHN_ORIGIN: 'https://different.test',
          PUBLIC_BASE_URL: 'https://different.test',
        }),
      ),
    ).toThrow(/not valid for WEBAUTHN_RP_ID/);
  });

  it('accepts a subdomain origin of the RP ID', () => {
    const config = loadConfig(
      env({
        WEBAUTHN_RP_ID: 'example.org',
        WEBAUTHN_ORIGIN: 'https://research.example.org',
        PUBLIC_BASE_URL: 'https://research.example.org',
      }),
    );
    expect(config.WEBAUTHN_ORIGINS).toEqual(['https://research.example.org']);
  });

  it('accepts several comma-separated origins, for a domain migration', () => {
    const config = loadConfig(
      env({
        WEBAUTHN_RP_ID: 'example.org',
        WEBAUTHN_ORIGIN: 'https://example.org, https://www.example.org',
        PUBLIC_BASE_URL: 'https://example.org',
      }),
    );
    expect(config.WEBAUTHN_ORIGINS).toHaveLength(2);
  });

  it('refuses insecure cookies in production', () => {
    // Without Secure the session cookie travels in clear text.
    expect(() =>
      loadConfig(
        env({
          NODE_ENV: 'production',
          SESSION_SECURE_COOKIES: 'false',
          WEBAUTHN_RP_ID: 'example.org',
          WEBAUTHN_ORIGIN: 'https://example.org',
          PUBLIC_BASE_URL: 'https://example.org',
        }),
      ),
    ).toThrow(/SESSION_SECURE_COOKIES must be true in production/);
  });

  it('refuses the .env.example database password in production', () => {
    // The placeholder is published in this repository, so a deployment still
    // carrying it has no database password at all.
    expect(() =>
      loadConfig(
        env({
          NODE_ENV: 'production',
          DB_PASSWORD: 'change-me',
          WEBAUTHN_RP_ID: 'example.org',
          WEBAUTHN_ORIGIN: 'https://example.org',
          PUBLIC_BASE_URL: 'https://example.org',
        }),
      ),
    ).toThrow(/still the placeholder/);
  });

  it('allows the placeholder password outside production', () => {
    // Development and CI copy .env.example verbatim on purpose; refusing here
    // would break the documented local setup to protect a throwaway database.
    expect(loadConfig(env({ DB_PASSWORD: 'change-me' })).DB_PASSWORD).toBe('change-me');
  });

  it('accepts a generated password in production', () => {
    // The check is an exact match against the shipped placeholders, not a
    // strength rule -- anything else is the operator's call.
    const config = loadConfig(
      env({
        NODE_ENV: 'production',
        DB_PASSWORD: 'change-me-please',
        WEBAUTHN_RP_ID: 'example.org',
        WEBAUTHN_ORIGIN: 'https://example.org',
        PUBLIC_BASE_URL: 'https://example.org',
      }),
    );
    expect(config.DB_PASSWORD).toBe('change-me-please');
  });

  it('rejects a PUBLIC_BASE_URL the relying party does not cover', () => {
    // The origins can all be valid and the canonical URL still point
    // somewhere else: the site comes up, serves pages, and fails at the login
    // form -- the last screen the operator reaches.
    expect(() =>
      loadConfig(
        env({
          WEBAUTHN_RP_ID: 'example.org',
          WEBAUTHN_ORIGIN: 'https://example.org',
          PUBLIC_BASE_URL: 'https://staging.example.test',
        }),
      ),
    ).toThrow(/PUBLIC_BASE_URL .* is not valid for WEBAUTHN_RP_ID/);
  });

  it('accepts a PUBLIC_BASE_URL on a subdomain of the RP ID', () => {
    // The www-versus-apex case: a real deployment, and not a mistake.
    const config = loadConfig(
      env({
        WEBAUTHN_RP_ID: 'example.org',
        WEBAUTHN_ORIGIN: 'https://www.example.org',
        PUBLIC_BASE_URL: 'https://www.example.org',
      }),
    );
    expect(config.PUBLIC_BASE_URL).toBe('https://www.example.org');
  });

  it('accepts a PUBLIC_BASE_URL that is not the only origin', () => {
    // During a domain migration several origins are live at once, and the
    // canonical URL is one of them rather than all of them.
    const config = loadConfig(
      env({
        WEBAUTHN_RP_ID: 'example.org',
        WEBAUTHN_ORIGIN: 'https://example.org,https://old.example.org',
        PUBLIC_BASE_URL: 'https://example.org',
      }),
    );
    expect(config.WEBAUTHN_ORIGINS).toHaveLength(2);
  });

  it('applies the __Host- cookie prefix only with secure cookies', () => {
    // Browsers reject the prefix without Secure, which would make the app
    // unusable over plain HTTP in development.
    expect(loadConfig(env({ SESSION_SECURE_COOKIES: 'true' })).sessionCookieName).toBe(
      '__Host-dsp_session',
    );
    expect(loadConfig(env({ SESSION_SECURE_COOKIES: 'false' })).sessionCookieName).toBe(
      'dsp_session',
    );
  });

  it('rejects a base URL with a path', () => {
    expect(() => loadConfig(env({ PUBLIC_BASE_URL: 'http://localhost:8080/app' }))).toThrow(
      ConfigError,
    );
  });

  it('rejects out-of-range numbers', () => {
    expect(() => loadConfig(env({ HTTP_PORT: '70000' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ HTTP_PORT: 'eight' }))).toThrow(ConfigError);
    // Below OWASP's recommended Argon2id memory floor.
    expect(() => loadConfig(env({ ARGON2_MEMORY_KIB: '1024' }))).toThrow(ConfigError);
  });

  it('treats whitespace-only values as unset', () => {
    expect(loadConfig(env({ HTTP_PORT: '   ' })).HTTP_PORT).toBe(8080);
  });

  it('defaults indexing to off', () => {
    // Research that has been crawled and archived cannot be un-crawled.
    expect(loadConfig(env()).ALLOW_SEARCH_INDEXING).toBe(false);
  });
});
