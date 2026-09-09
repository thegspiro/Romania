/**
 * Data access for authentication.
 *
 * Every function here takes the connection explicitly so that callers can run
 * a whole ceremony inside one transaction when it must be atomic (registering
 * the first passkey together with its recovery codes, for instance).
 */
import { randomBytes } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { execute, queryOne, queryRows, type Pool, type PoolConnection } from '../db/pool.js';

export interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  passwordHash: string;
  /** Opaque handle presented to authenticators; see the schema comment. */
  webauthnUserHandle: Buffer;
}

interface AdminUserRow extends RowDataPacket {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  webauthn_user_handle: Buffer;
}

function toAdminUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    webauthnUserHandle: row.webauthn_user_handle,
  };
}

const USER_COLUMNS = 'id, username, display_name, password_hash, webauthn_user_handle';

export async function findUserByUsername(
  db: Pool | PoolConnection,
  username: string,
): Promise<AdminUser | null> {
  const row = await queryOne<AdminUserRow>(
    db,
    `SELECT ${USER_COLUMNS} FROM admin_user WHERE username = ?`,
    [username],
  );
  return row === null ? null : toAdminUser(row);
}

export async function findUserById(
  db: Pool | PoolConnection,
  id: number,
): Promise<AdminUser | null> {
  const row = await queryOne<AdminUserRow>(
    db,
    `SELECT ${USER_COLUMNS} FROM admin_user WHERE id = ?`,
    [id],
  );
  return row === null ? null : toAdminUser(row);
}

export async function countUsers(db: Pool | PoolConnection): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    db,
    'SELECT COUNT(*) AS total FROM admin_user',
  );
  return row?.total ?? 0;
}

export async function createUser(
  db: Pool | PoolConnection,
  input: { username: string; displayName: string; passwordHash: string },
): Promise<number> {
  const result = await execute(
    db,
    `INSERT INTO admin_user (username, display_name, password_hash, webauthn_user_handle)
     VALUES (?, ?, ?, ?)`,
    [input.username, input.displayName, input.passwordHash, randomBytes(32)],
  );
  return result.insertId;
}

export async function updatePasswordHash(
  db: Pool | PoolConnection,
  userId: number,
  passwordHash: string,
): Promise<void> {
  await execute(
    db,
    'UPDATE admin_user SET password_hash = ?, password_changed_at = NOW(3) WHERE id = ?',
    [passwordHash, userId],
  );
}

// --- WebAuthn credentials --------------------------------------------------

export interface StoredCredential {
  id: number;
  userId: number;
  /** Base64url form, which is what the WebAuthn APIs exchange. */
  credentialId: string;
  publicKey: Buffer;
  signCount: number;
  transports: string[];
  label: string;
  backedUp: boolean;
  deviceType: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface CredentialRow extends RowDataPacket {
  id: number;
  user_id: number;
  credential_id: Buffer;
  public_key: Buffer;
  sign_count: number;
  transports: string | null;
  label: string;
  backed_up: number;
  device_type: string;
  created_at: Date;
  last_used_at: Date | null;
}

function toCredential(row: CredentialRow): StoredCredential {
  return {
    id: row.id,
    userId: row.user_id,
    credentialId: row.credential_id.toString('base64url'),
    publicKey: row.public_key,
    signCount: row.sign_count,
    transports: row.transports === null || row.transports === '' ? [] : row.transports.split(','),
    label: row.label,
    backedUp: row.backed_up === 1,
    deviceType: row.device_type,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

const CREDENTIAL_COLUMNS =
  'id, user_id, credential_id, public_key, sign_count, transports, label, ' +
  'backed_up, device_type, created_at, last_used_at';

export async function listCredentials(
  db: Pool | PoolConnection,
  userId: number,
): Promise<StoredCredential[]> {
  const rows = await queryRows<CredentialRow>(
    db,
    `SELECT ${CREDENTIAL_COLUMNS} FROM webauthn_credential WHERE user_id = ? ORDER BY created_at`,
    [userId],
  );
  return rows.map(toCredential);
}

export async function findCredentialByCredentialId(
  db: Pool | PoolConnection,
  credentialId: string,
): Promise<StoredCredential | null> {
  let raw: Buffer;
  try {
    raw = Buffer.from(credentialId, 'base64url');
  } catch {
    return null;
  }
  if (raw.length === 0) return null;

  const row = await queryOne<CredentialRow>(
    db,
    `SELECT ${CREDENTIAL_COLUMNS} FROM webauthn_credential WHERE credential_id = ?`,
    [raw],
  );
  return row === null ? null : toCredential(row);
}

export interface NewCredential {
  userId: number;
  credentialId: string;
  publicKey: Buffer;
  signCount: number;
  transports: string[];
  label: string;
  backedUp: boolean;
  deviceType: string;
  aaguid: Buffer | null;
}

export async function insertCredential(
  db: Pool | PoolConnection,
  credential: NewCredential,
): Promise<number> {
  const result = await execute(
    db,
    `INSERT INTO webauthn_credential
       (user_id, credential_id, public_key, sign_count, transports, aaguid,
        backed_up, device_type, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      credential.userId,
      Buffer.from(credential.credentialId, 'base64url'),
      credential.publicKey,
      credential.signCount,
      credential.transports.length === 0 ? null : credential.transports.join(','),
      credential.aaguid,
      credential.backedUp ? 1 : 0,
      credential.deviceType,
      credential.label,
    ],
  );
  return result.insertId;
}

export async function recordCredentialUse(
  db: Pool | PoolConnection,
  credentialRowId: number,
  signCount: number,
): Promise<void> {
  await execute(
    db,
    'UPDATE webauthn_credential SET sign_count = ?, last_used_at = NOW(3) WHERE id = ?',
    [signCount, credentialRowId],
  );
}

export async function deleteCredential(
  db: Pool | PoolConnection,
  userId: number,
  credentialRowId: number,
): Promise<boolean> {
  const result = await execute(db, 'DELETE FROM webauthn_credential WHERE id = ? AND user_id = ?', [
    credentialRowId,
    userId,
  ]);
  return result.affectedRows > 0;
}

// --- Recovery codes --------------------------------------------------------

export interface StoredRecoveryCode {
  id: number;
  codeHash: string;
}

export async function replaceRecoveryCodes(
  db: Pool | PoolConnection,
  userId: number,
  codeHashes: string[],
): Promise<void> {
  await execute(db, 'DELETE FROM recovery_code WHERE user_id = ?', [userId]);
  for (const codeHash of codeHashes) {
    await execute(db, 'INSERT INTO recovery_code (user_id, code_hash) VALUES (?, ?)', [
      userId,
      codeHash,
    ]);
  }
}

export async function listUnusedRecoveryCodes(
  db: Pool | PoolConnection,
  userId: number,
): Promise<StoredRecoveryCode[]> {
  const rows = await queryRows<RowDataPacket & { id: number; code_hash: string }>(
    db,
    'SELECT id, code_hash FROM recovery_code WHERE user_id = ? AND used_at IS NULL ORDER BY id',
    [userId],
  );
  return rows.map((row) => ({ id: row.id, codeHash: row.code_hash }));
}

/**
 * Marks a recovery code as spent.
 *
 * The `used_at IS NULL` guard makes this a compare-and-set: two concurrent
 * requests submitting the same code cannot both succeed.
 */
export async function consumeRecoveryCode(
  db: Pool | PoolConnection,
  codeId: number,
): Promise<boolean> {
  const result = await execute(
    db,
    'UPDATE recovery_code SET used_at = NOW(3) WHERE id = ? AND used_at IS NULL',
    [codeId],
  );
  return result.affectedRows === 1;
}

export async function countUnusedRecoveryCodes(
  db: Pool | PoolConnection,
  userId: number,
): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    db,
    'SELECT COUNT(*) AS total FROM recovery_code WHERE user_id = ? AND used_at IS NULL',
    [userId],
  );
  return row?.total ?? 0;
}

// --- Login throttling ------------------------------------------------------

export async function recordLoginAttempt(
  db: Pool | PoolConnection,
  input: { identifier: string; ip: Buffer | null; successful: boolean },
): Promise<void> {
  await execute(
    db,
    'INSERT INTO login_attempt (identifier, ip_address, successful) VALUES (?, ?, ?)',
    [input.identifier.slice(0, 190), input.ip, input.successful ? 1 : 0],
  );
}

/**
 * Counts failed attempts in the recent window.
 *
 * Both the username and the source address are counted, and the larger of the
 * two decides. Throttling only by username lets one attacker lock the operator
 * out; throttling only by address lets a distributed attacker through.
 */
export async function countRecentFailures(
  db: Pool | PoolConnection,
  input: { identifier: string; ip: Buffer | null; windowMinutes: number },
): Promise<number> {
  const byIdentifier = await queryOne<RowDataPacket & { total: number }>(
    db,
    `SELECT COUNT(*) AS total FROM login_attempt
      WHERE successful = 0
        AND identifier = ?
        AND attempted_at > NOW(3) - INTERVAL ? MINUTE`,
    [input.identifier.slice(0, 190), input.windowMinutes],
  );

  let byIp = 0;
  if (input.ip !== null) {
    const row = await queryOne<RowDataPacket & { total: number }>(
      db,
      `SELECT COUNT(*) AS total FROM login_attempt
        WHERE successful = 0
          AND ip_address = ?
          AND attempted_at > NOW(3) - INTERVAL ? MINUTE`,
      [input.ip, input.windowMinutes],
    );
    byIp = row?.total ?? 0;
  }

  return Math.max(byIdentifier?.total ?? 0, byIp);
}

/** Clears the failure history after a successful login. */
export async function clearLoginFailures(
  db: Pool | PoolConnection,
  identifier: string,
): Promise<void> {
  await execute(db, 'DELETE FROM login_attempt WHERE identifier = ? AND successful = 0', [
    identifier.slice(0, 190),
  ]);
}

/** Removes attempt records older than the retention window. */
export async function pruneLoginAttempts(
  db: Pool | PoolConnection,
  retentionDays = 30,
): Promise<number> {
  const result = await execute(
    db,
    'DELETE FROM login_attempt WHERE attempted_at < NOW(3) - INTERVAL ? DAY',
    [retentionDays],
  );
  return result.affectedRows;
}
