/**
 * Share links: letting a supervisor read one unpublished chapter.
 *
 * This is the one deliberate exception to the rule the application is built
 * around, so the machinery is kept deliberately small and the reasoning is
 * written down rather than implied.
 *
 * **The token is the credential.** 256 bits, shown once at creation, stored
 * only as `sha256` -- the same contract as a session token and a recovery
 * code. A dump of `essay_share` lets nobody read anything.
 *
 * **Validation happens in one function.** `resolveShare` is the only place a
 * token becomes an access decision: it hashes, looks up, and refuses an
 * expired or revoked link. Everything downstream receives an essay id and
 * trusts it, which is only safe because there is exactly one door.
 *
 * **What the holder may see is not decided here.** `shareViewer` widens
 * `visibilityFilter` by one id; the renderer and every repository then behave
 * exactly as they do for a visitor. Nothing in this module reads content.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { execute, queryOne, queryRows, type Pool, type PoolConnection } from '../db/pool.js';

/** Matches the session token shape: 256 bits, URL-safe, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const MIN_EXPIRY_DAYS = 1;
export const MAX_EXPIRY_DAYS = 180;
export const DEFAULT_EXPIRY_DAYS = 30;

export type ShareState = 'live' | 'expired' | 'revoked';

export interface ShareRecord {
  id: number;
  essayId: number;
  label: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  lastViewedAt: Date | null;
  viewCount: number;
  createdAt: Date;
  /**
   * Derived, so the listing does not have to compare dates in a template.
   * `resolveShare` decides access from the columns, never from this -- a view
   * model must not be the thing a security decision is read off.
   */
  state: ShareState;
}

export interface IssuedShare {
  share: ShareRecord;
  /**
   * The token, in the clear. Available exactly once, at creation: it is never
   * stored and cannot be recovered. The caller shows it and forgets it.
   */
  token: string;
}

function toRecord(row: RowDataPacket): ShareRecord {
  return {
    id: Number(row.id),
    essayId: Number(row.content_item_id),
    label: (row.label as string | null) ?? null,
    expiresAt: row.expires_at as Date,
    revokedAt: (row.revoked_at as Date | null) ?? null,
    lastViewedAt: (row.last_viewed_at as Date | null) ?? null,
    viewCount: Number(row.view_count ?? 0),
    createdAt: row.created_at as Date,
    state: shareState((row.revoked_at as Date | null) ?? null, row.expires_at as Date),
  };
}

function shareState(revokedAt: Date | null, expiresAt: Date): ShareState {
  if (revokedAt !== null) return 'revoked';
  return expiresAt.getTime() <= Date.now() ? 'expired' : 'live';
}

const COLUMNS = `
  id, content_item_id, label, expires_at, revoked_at,
  last_viewed_at, view_count, created_at
`;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Whether a submitted token is even the right shape.
 *
 * Checked before hashing so a hostile client cannot make the server hash
 * megabytes, and so an obviously malformed token costs no database round trip.
 */
export function looksLikeShareToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export interface IssueShareOptions {
  essayId: number;
  label: string;
  expiresInDays: number;
}

export async function issueShare(
  db: Pool | PoolConnection,
  options: IssueShareOptions,
): Promise<IssuedShare> {
  const days = Math.min(
    Math.max(Math.trunc(options.expiresInDays), MIN_EXPIRY_DAYS),
    MAX_EXPIRY_DAYS,
  );
  const token = randomBytes(32).toString('base64url');
  const label = options.label.trim().slice(0, 190);

  const result = await execute(
    db,
    `INSERT INTO essay_share (content_item_id, token_sha256, label, expires_at)
     VALUES (?, ?, ?, NOW(3) + INTERVAL ? DAY)`,
    [options.essayId, hashToken(token), label === '' ? null : label, days],
  );

  const row = await queryOne<RowDataPacket>(db, `SELECT ${COLUMNS} FROM essay_share WHERE id = ?`, [
    result.insertId,
  ]);
  if (row === null) throw new Error('the share row vanished immediately after insert');

  return { share: toRecord(row), token };
}

export type ShareRefusal = 'unknown' | 'expired' | 'revoked';

export type ShareResolution =
  { ok: true; share: ShareRecord } | { ok: false; reason: ShareRefusal };

/**
 * Turns a token into an essay id, or refuses.
 *
 * The single door. Every caller that acts on a share reaches it through here,
 * so expiry and revocation cannot be forgotten at one call site and remembered
 * at another.
 *
 * The refusal reason is for the server's log, never for the response: a
 * visitor is told the same thing whether the link is unknown, expired or
 * revoked, because distinguishing them says whether a chapter exists.
 */
export async function resolveShare(
  db: Pool | PoolConnection,
  token: unknown,
): Promise<ShareResolution> {
  if (!looksLikeShareToken(token)) return { ok: false, reason: 'unknown' };

  const row = await queryOne<RowDataPacket>(
    db,
    `SELECT ${COLUMNS}, token_sha256 FROM essay_share WHERE token_sha256 = ?`,
    [hashToken(token)],
  );
  if (row === null) return { ok: false, reason: 'unknown' };

  // The lookup already matched on the hash, so this compares equal values.
  // Done in constant time anyway: the cost is nothing and the habit is what
  // keeps a future refactor that compares tokens directly from leaking timing.
  const stored = Buffer.from(String(row.token_sha256), 'utf8');
  const offered = Buffer.from(hashToken(token), 'utf8');
  if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
    return { ok: false, reason: 'unknown' };
  }

  const share = toRecord(row);
  if (share.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (share.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  return { ok: true, share };
}

/**
 * Records that a link was opened.
 *
 * Enough to answer "has she looked at it yet?". Deliberately not an access
 * log: this stores a count and a timestamp rather than a row per visit with an
 * address attached, because the operator's question is the former and the
 * latter accumulates information about a third party nobody asked for.
 */
export async function recordShareView(db: Pool | PoolConnection, shareId: number): Promise<void> {
  await execute(
    db,
    `UPDATE essay_share
        SET view_count = view_count + 1, last_viewed_at = NOW(3)
      WHERE id = ?`,
    [shareId],
  );
}

export async function listShares(
  db: Pool | PoolConnection,
  essayId: number,
): Promise<ShareRecord[]> {
  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT ${COLUMNS} FROM essay_share
      WHERE content_item_id = ?
      ORDER BY created_at DESC`,
    [essayId],
  );
  return rows.map(toRecord);
}

/**
 * Revokes a link, effective on the next request.
 *
 * Scoped to the essay as well as the id so a mistyped share id cannot revoke
 * a link belonging to another chapter.
 */
export async function revokeShare(
  db: Pool | PoolConnection,
  essayId: number,
  shareId: number,
): Promise<boolean> {
  const result = await execute(
    db,
    `UPDATE essay_share
        SET revoked_at = NOW(3)
      WHERE id = ? AND content_item_id = ? AND revoked_at IS NULL`,
    [shareId, essayId],
  );
  return result.affectedRows > 0;
}

// --- Comments ---------------------------------------------------------------

export const MAX_COMMENT_LENGTH = 4000;

export interface ShareComment {
  id: number;
  essayId: number;
  shareId: number | null;
  /** 1-based paragraph, matching `#pN`, or null for the chapter as a whole. */
  blockIndex: number | null;
  body: string;
  resolvedAt: Date | null;
  createdAt: Date;
  /** The label of the link it arrived through, when that link still exists. */
  shareLabel: string | null;
}

export async function addShareComment(
  db: Pool | PoolConnection,
  input: { essayId: number; shareId: number; blockIndex: number | null; body: string },
): Promise<number | null> {
  const body = input.body.trim();
  if (body === '') return null;

  const blockIndex =
    input.blockIndex === null || !Number.isSafeInteger(input.blockIndex) || input.blockIndex <= 0
      ? null
      : input.blockIndex;

  const result = await execute(
    db,
    `INSERT INTO essay_share_comment (content_item_id, share_id, block_index, body)
     VALUES (?, ?, ?, ?)`,
    [input.essayId, input.shareId, blockIndex, body.slice(0, MAX_COMMENT_LENGTH)],
  );
  return result.insertId;
}

export async function listShareComments(
  db: Pool | PoolConnection,
  essayId: number,
): Promise<ShareComment[]> {
  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT c.id, c.content_item_id, c.share_id, c.block_index, c.body,
            c.resolved_at, c.created_at, s.label AS share_label
       FROM essay_share_comment c
       LEFT JOIN essay_share s ON s.id = c.share_id
      WHERE c.content_item_id = ?
      ORDER BY c.block_index IS NULL, c.block_index ASC, c.created_at ASC`,
    [essayId],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    essayId: Number(row.content_item_id),
    shareId: row.share_id === null ? null : Number(row.share_id),
    blockIndex: row.block_index === null ? null : Number(row.block_index),
    body: String(row.body),
    resolvedAt: (row.resolved_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    shareLabel: (row.share_label as string | null) ?? null,
  }));
}

/** The comments one link holder wrote, so they can see their own. */
export async function listCommentsFromShare(
  db: Pool | PoolConnection,
  shareId: number,
): Promise<ShareComment[]> {
  const rows = await queryRows<RowDataPacket>(
    db,
    `SELECT id, content_item_id, share_id, block_index, body, resolved_at, created_at
       FROM essay_share_comment
      WHERE share_id = ?
      ORDER BY block_index IS NULL, block_index ASC, created_at ASC`,
    [shareId],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    essayId: Number(row.content_item_id),
    shareId: row.share_id === null ? null : Number(row.share_id),
    blockIndex: row.block_index === null ? null : Number(row.block_index),
    body: String(row.body),
    resolvedAt: (row.resolved_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    shareLabel: null,
  }));
}

export async function setCommentResolved(
  db: Pool | PoolConnection,
  essayId: number,
  commentId: number,
  resolved: boolean,
): Promise<boolean> {
  // IF() with a bound flag rather than interpolating NOW(3) or NULL into the
  // statement. CLAUDE.md names the two places allowed to build SQL text and
  // this is not one of them -- a boolean is still a value.
  const result = await execute(
    db,
    `UPDATE essay_share_comment
        SET resolved_at = IF(?, NOW(3), NULL)
      WHERE id = ? AND content_item_id = ?`,
    [resolved ? 1 : 0, commentId, essayId],
  );
  return result.affectedRows > 0;
}

export async function countUnresolvedComments(
  db: Pool | PoolConnection,
  essayId: number,
): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(*) AS total FROM essay_share_comment
      WHERE content_item_id = ? AND resolved_at IS NULL`,
    [essayId],
  );
  return Number(row?.total ?? 0);
}
