/**
 * MySQL connection pool and typed query helpers.
 *
 * Every statement in the application goes through these helpers with `?`
 * placeholders. String interpolation into SQL is never acceptable, and the
 * pool is deliberately created with `multipleStatements: false` so that even
 * a mistake in a query string cannot be escalated into stacked statements.
 */
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Config } from '../config.js';

export type { Pool, PoolConnection } from 'mysql2/promise';

/** Values accepted as bound query parameters. */
export type SqlParam = string | number | boolean | Date | Buffer | null;

export function createPool(config: Config): Pool {
  return mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectionLimit: config.DB_CONNECTION_LIMIT,
    waitForConnections: true,
    // Never enable this on the application pool. See the file comment.
    multipleStatements: false,
    charset: 'utf8mb4_0900_ai_ci',
    // Store and read everything in UTC; formatting to a local zone is a
    // presentation concern handled in templates.
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    // DECIMAL columns (latitude/longitude) arrive as numbers rather than
    // strings, which is what the mapping code expects.
    decimalNumbers: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });
}

/** Runs a SELECT and returns the rows. */
export async function queryRows<T extends RowDataPacket>(
  db: Pool | PoolConnection,
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const [rows] = await db.execute<T[]>(sql, params);
  return rows;
}

/** Runs a SELECT expected to match at most one row. */
export async function queryOne<T extends RowDataPacket>(
  db: Pool | PoolConnection,
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const rows = await queryRows<T>(db, sql, params);
  return rows[0] ?? null;
}

/** Runs an INSERT/UPDATE/DELETE and returns the result header. */
export async function execute(
  db: Pool | PoolConnection,
  sql: string,
  params: SqlParam[] = [],
): Promise<ResultSetHeader> {
  const [result] = await db.execute<ResultSetHeader>(sql, params);
  return result;
}

/**
 * Runs `handler` inside a transaction, committing on success and rolling back
 * on any thrown error.
 *
 * Note that MySQL commits implicitly around DDL, so this provides no
 * protection for schema changes -- only for the data statements the
 * application issues at runtime.
 */
export async function withTransaction<T>(
  pool: Pool,
  handler: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    try {
      const result = await handler(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    connection.release();
  }
}

/**
 * Renders a LIMIT/OFFSET clause from validated integers.
 *
 * Placeholders in LIMIT are handled inconsistently across driver versions
 * because the protocol expects an integer literal there, so the values are
 * checked to be non-negative safe integers and then written into the SQL.
 * This function is the only place in the codebase permitted to build SQL by
 * concatenation, and it can only ever emit digits.
 */
export function limitOffsetClause(limit: number, offset = 0): string {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError(`limit must be a non-negative safe integer, received ${String(limit)}`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError(`offset must be a non-negative safe integer, received ${String(offset)}`);
  }
  return `LIMIT ${limit} OFFSET ${offset}`;
}
