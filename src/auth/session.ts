/**
 * Server-side sessions.
 *
 * The cookie carries a random token; the database stores only its SHA-256.
 * A dump of the `session` table therefore hands an attacker nothing usable,
 * which is not true of designs that store the token itself.
 *
 * Two-factor login is expressed as a session state rather than a separate
 * store: a session that has passed the password but not yet the passkey is
 * `password_pending` and is rejected by every authenticated route.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { execute, queryOne, type Pool, type PoolConnection } from '../db/pool.js';

export type AuthState = 'password_pending' | 'authenticated';

export interface SessionRecord {
  id: string;
  userId: number;
  csrfToken: string;
  authState: AuthState;
  expiresAt: Date;
  webauthnChallenge: string | null;
}

export interface NewSession {
  /** Raw token for the cookie. Never stored, never logged. */
  token: string;
  record: SessionRecord;
}

/**
 * How stale `last_seen_at` may become before a request refreshes it.
 *
 * Rolling expiry should not mean a database write on every single request,
 * so the timestamp and the expiry are only pushed forward once per interval.
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** A WebAuthn ceremony must complete within this window. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface SessionRow extends RowDataPacket {
  id: string;
  user_id: number;
  csrf_token: string;
  auth_state: AuthState;
  expires_at: Date;
  last_seen_at: Date;
  webauthn_challenge: string | null;
  webauthn_challenge_expires_at: Date | null;
}

/** 256 bits of entropy, URL-safe. */
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Converts a textual IP address to MySQL's packed binary form.
 *
 * Returns null for anything unparseable rather than throwing: a malformed
 * X-Forwarded-For must not be able to break login.
 */
function packIp(ip: string | undefined): Buffer | null {
  if (ip === undefined || ip === '') return null;
  // IPv4-mapped IPv6 ("::ffff:203.0.113.4") is stored as the IPv4 address so
  // that rate limiting groups the same client together.
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return Buffer.from(octets);
  }

  if (!normalized.includes(':')) return null;
  try {
    // Node validates and canonicalises IPv6 via the URL parser.
    const parsed = new URL(`http://[${normalized}]`);
    const groups = expandIpv6(parsed.hostname.slice(1, -1));
    return groups === null ? null : Buffer.from(groups);
  } catch {
    return null;
  }
}

function expandIpv6(address: string): number[] | null {
  const [head, tail] = address.split('::');
  const headGroups = head === undefined || head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;
  if (address.includes('::') ? missing < 0 : missing !== 0) return null;

  const groups = [
    ...headGroups,
    ...Array<string>(address.includes('::') ? missing : 0).fill('0'),
    ...tailGroups,
  ];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

export interface CreateSessionOptions {
  userId: number;
  ttlMs: number;
  ip?: string | undefined;
  userAgent?: string | undefined;
  authState?: AuthState;
}

export async function createSession(
  db: Pool | PoolConnection,
  options: CreateSessionOptions,
): Promise<NewSession> {
  const token = randomToken();
  const id = hashToken(token);
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + options.ttlMs);
  const authState = options.authState ?? 'password_pending';

  await execute(
    db,
    `INSERT INTO session (id, user_id, csrf_token, auth_state, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      options.userId,
      csrfToken,
      authState,
      packIp(options.ip),
      options.userAgent?.slice(0, 255) ?? null,
      expiresAt,
    ],
  );

  return {
    token,
    record: {
      id,
      userId: options.userId,
      csrfToken,
      authState,
      expiresAt,
      webauthnChallenge: null,
    },
  };
}

/**
 * Loads the session for a cookie token, refreshing its rolling expiry.
 *
 * Returns null when the token is unknown or expired. Expired rows are left
 * for the sweeper rather than deleted here, so that a read stays a read.
 */
export async function loadSession(
  db: Pool | PoolConnection,
  token: string,
  ttlMs: number,
): Promise<SessionRecord | null> {
  if (token === '') return null;
  const id = hashToken(token);

  const row = await queryOne<SessionRow>(
    db,
    `SELECT id, user_id, csrf_token, auth_state, expires_at, last_seen_at,
            webauthn_challenge, webauthn_challenge_expires_at
       FROM session
      WHERE id = ? AND expires_at > NOW(3)`,
    [id],
  );
  if (row === null) return null;

  const now = Date.now();
  if (now - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await execute(db, 'UPDATE session SET last_seen_at = NOW(3), expires_at = ? WHERE id = ?', [
      new Date(now + ttlMs),
      id,
    ]);
  }

  const challengeValid =
    row.webauthn_challenge !== null &&
    row.webauthn_challenge_expires_at !== null &&
    row.webauthn_challenge_expires_at.getTime() > now;

  return {
    id: row.id,
    userId: row.user_id,
    csrfToken: row.csrf_token,
    authState: row.auth_state,
    expiresAt: row.expires_at,
    webauthnChallenge: challengeValid ? row.webauthn_challenge : null,
  };
}

/**
 * Marks a session as fully authenticated after the second factor succeeds.
 *
 * The session id is rotated so that a token observed during the
 * password-only phase cannot be reused as an authenticated one. The caller
 * must write the returned token back to the cookie.
 */
export async function promoteSession(
  db: Pool | PoolConnection,
  sessionId: string,
  ttlMs: number,
): Promise<string> {
  const token = randomToken();
  const newId = hashToken(token);

  await execute(
    db,
    `UPDATE session
        SET id = ?,
            auth_state = 'authenticated',
            csrf_token = ?,
            webauthn_challenge = NULL,
            webauthn_challenge_expires_at = NULL,
            last_seen_at = NOW(3),
            expires_at = ?
      WHERE id = ?`,
    [newId, randomToken(), new Date(Date.now() + ttlMs), sessionId],
  );

  return token;
}

export async function setChallenge(
  db: Pool | PoolConnection,
  sessionId: string,
  challenge: string,
): Promise<void> {
  await execute(
    db,
    'UPDATE session SET webauthn_challenge = ?, webauthn_challenge_expires_at = ? WHERE id = ?',
    [challenge, new Date(Date.now() + CHALLENGE_TTL_MS), sessionId],
  );
}

/** Clears the challenge. Called after every ceremony, successful or not. */
export async function clearChallenge(db: Pool | PoolConnection, sessionId: string): Promise<void> {
  await execute(
    db,
    'UPDATE session SET webauthn_challenge = NULL, webauthn_challenge_expires_at = NULL WHERE id = ?',
    [sessionId],
  );
}

export async function destroySession(db: Pool | PoolConnection, sessionId: string): Promise<void> {
  await execute(db, 'DELETE FROM session WHERE id = ?', [sessionId]);
}

/** Invalidates every session for a user. Used after a password change. */
export async function destroyUserSessions(
  db: Pool | PoolConnection,
  userId: number,
): Promise<number> {
  const result = await execute(db, 'DELETE FROM session WHERE user_id = ?', [userId]);
  return result.affectedRows;
}

export async function sweepExpiredSessions(db: Pool | PoolConnection): Promise<number> {
  const result = await execute(db, 'DELETE FROM session WHERE expires_at <= NOW(3)');
  return result.affectedRows;
}

/**
 * Constant-time comparison of a submitted CSRF token against the session's.
 *
 * A plain `===` leaks the position of the first differing byte through timing;
 * with tokens this is a weak signal but there is no reason to emit it.
 */
export function csrfTokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;

  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  if (expectedBytes.length !== providedBytes.length) return false;

  return timingSafeEqual(expectedBytes, providedBytes);
}

export { packIp as packIpAddress };
