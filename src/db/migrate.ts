/**
 * Migration runner.
 *
 * Migrations are plain numbered SQL files in db/migrations, applied in order
 * and recorded in the `schema_migration` table. There is no ORM and no
 * automatic schema synchronisation: the schema is reviewed as SQL, in the
 * diff, like any other code.
 *
 * Two properties matter for a service that may be started by several
 * containers at once:
 *
 *   1. A MySQL named lock serialises runners, so two containers booting
 *      together cannot apply the same migration twice.
 *   2. MySQL commits implicitly around DDL, so a file that fails partway
 *      cannot be rolled back. Up-migrations are therefore written to be
 *      re-runnable (CREATE TABLE IF NOT EXISTS, INSERT IGNORE) and the
 *      version is recorded only after the whole file succeeds.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { loadConfig, type Config } from '../config.js';

const LOCK_NAME = 'dissertation_platform:migrate';
const LOCK_TIMEOUT_SECONDS = 60;
const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

export interface Migration {
  version: number;
  name: string;
  upPath: string;
  downPath: string;
}

export interface MigrationEvent {
  level: 'info' | 'warn';
  message: string;
}

type Reporter = (event: MigrationEvent) => void;

const silentReporter: Reporter = () => {};

/** Default location of the migration files, relative to this module. */
export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return process.env.MIGRATIONS_DIR ?? resolve(here, '..', '..', 'db', 'migrations');
}

/**
 * Reads and pairs the migration files.
 *
 * A migration without a matching `.down.sql` is rejected: an un-reversible
 * migration is only discovered when a rollback is already needed.
 */
export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory);
  const ups = new Map<number, { name: string; path: string }>();
  const downs = new Map<number, string>();

  for (const entry of entries) {
    const match = FILENAME_PATTERN.exec(entry);
    if (!match) {
      if (entry.endsWith('.sql')) {
        throw new Error(
          `Migration file "${entry}" does not match NNNN_name.up.sql / NNNN_name.down.sql`,
        );
      }
      continue;
    }
    const [, versionText, name, direction] = match;
    const version = Number(versionText);
    if (direction === 'up') {
      if (ups.has(version)) {
        throw new Error(`Duplicate up-migration for version ${version}`);
      }
      ups.set(version, { name: name!, path: join(directory, entry) });
    } else {
      downs.set(version, join(directory, entry));
    }
  }

  const migrations: Migration[] = [];
  for (const [version, up] of [...ups.entries()].sort((a, b) => a[0] - b[0])) {
    const downPath = downs.get(version);
    if (downPath === undefined) {
      throw new Error(`Migration ${version} (${up.name}) has no .down.sql counterpart`);
    }
    migrations.push({ version, name: up.name, upPath: up.path, downPath });
  }

  return migrations;
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/**
 * Opens the dedicated migration connection.
 *
 * This is the only connection in the system with `multipleStatements`
 * enabled. It executes trusted files from disk and nothing else; naive
 * splitting on semicolons would corrupt statements containing them.
 */
async function connect(config: Config): Promise<Connection> {
  return mysql.createConnection({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    multipleStatements: true,
    charset: 'utf8mb4_0900_ai_ci',
    timezone: 'Z',
  });
}

async function ensureRegistry(connection: Connection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version    INT UNSIGNED NOT NULL,
      name       VARCHAR(190) NOT NULL,
      checksum   CHAR(64)     NOT NULL,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (version)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci
  `);
}

interface AppliedRow extends RowDataPacket {
  version: number;
  name: string;
  checksum: string;
}

async function readApplied(connection: Connection): Promise<Map<number, AppliedRow>> {
  const [rows] = await connection.query<AppliedRow[]>(
    'SELECT version, name, checksum FROM schema_migration ORDER BY version',
  );
  return new Map(rows.map((row) => [row.version, row]));
}

async function acquireLock(connection: Connection): Promise<void> {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
    LOCK_NAME,
    LOCK_TIMEOUT_SECONDS,
  ]);
  if (rows[0]?.acquired !== 1) {
    throw new Error(
      `Could not acquire the migration lock within ${LOCK_TIMEOUT_SECONDS}s. ` +
        'Another process is probably migrating; retry once it has finished.',
    );
  }
}

async function releaseLock(connection: Connection): Promise<void> {
  await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
}

export interface MigrateOptions {
  config?: Config;
  directory?: string;
  report?: Reporter;
}

/** Applies every migration that has not yet been recorded. */
export async function migrateUp(options: MigrateOptions = {}): Promise<number[]> {
  const config = options.config ?? loadConfig();
  const directory = options.directory ?? defaultMigrationsDir();
  const report = options.report ?? silentReporter;

  const migrations = await loadMigrations(directory);
  const connection = await connect(config);
  const applied: number[] = [];

  try {
    await acquireLock(connection);
    try {
      await ensureRegistry(connection);
      const already = await readApplied(connection);

      for (const migration of migrations) {
        const sql = await readFile(migration.upPath, 'utf8');
        const digest = checksum(sql);
        const record = already.get(migration.version);

        if (record !== undefined) {
          if (record.checksum !== digest) {
            throw new Error(
              `Migration ${migration.version} (${migration.name}) has changed since it was ` +
                'applied. Editing an applied migration means deployed databases no longer ' +
                'match the file. Add a new migration instead, or restore the original file.',
            );
          }
          continue;
        }

        report({ level: 'info', message: `applying ${migration.version} ${migration.name}` });
        try {
          await connection.query(sql);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Migration ${migration.version} (${migration.name}) failed: ${reason}\n` +
              'MySQL cannot roll back DDL, so the database may be partially migrated. ' +
              'Fix the cause and re-run; up-migrations are written to be re-runnable.',
          );
        }

        await connection.query(
          'INSERT INTO schema_migration (version, name, checksum) VALUES (?, ?, ?)',
          [migration.version, migration.name, digest],
        );
        applied.push(migration.version);
      }
    } finally {
      await releaseLock(connection);
    }
  } finally {
    await connection.end();
  }

  if (applied.length === 0) {
    report({ level: 'info', message: 'database is up to date' });
  }
  return applied;
}

/**
 * Rolls back every applied migration with a version greater than
 * `targetVersion`, newest first. `targetVersion` of 0 empties the schema.
 */
export async function migrateDown(
  targetVersion: number,
  options: MigrateOptions = {},
): Promise<number[]> {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new TypeError('targetVersion must be a non-negative integer');
  }

  const config = options.config ?? loadConfig();
  const directory = options.directory ?? defaultMigrationsDir();
  const report = options.report ?? silentReporter;

  const migrations = await loadMigrations(directory);
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const connection = await connect(config);
  const reverted: number[] = [];

  try {
    await acquireLock(connection);
    try {
      await ensureRegistry(connection);
      const already = await readApplied(connection);

      const toRevert = [...already.keys()]
        .filter((version) => version > targetVersion)
        .sort((a, b) => b - a);

      for (const version of toRevert) {
        const migration = byVersion.get(version);
        if (migration === undefined) {
          throw new Error(
            `Version ${version} is recorded as applied but its files are missing from ` +
              `${directory}. Restore them before rolling back.`,
          );
        }

        report({ level: 'info', message: `reverting ${version} ${migration.name}` });
        const sql = await readFile(migration.downPath, 'utf8');
        await connection.query(sql);
        await connection.query('DELETE FROM schema_migration WHERE version = ?', [version]);
        reverted.push(version);
      }
    } finally {
      await releaseLock(connection);
    }
  } finally {
    await connection.end();
  }

  if (reverted.length === 0) {
    report({ level: 'info', message: `nothing to revert above version ${targetVersion}` });
  }
  return reverted;
}

export interface MigrationStatus {
  version: number;
  name: string;
  applied: boolean;
  appliedAt: Date | null;
}

export async function migrationStatus(options: MigrateOptions = {}): Promise<MigrationStatus[]> {
  const config = options.config ?? loadConfig();
  const directory = options.directory ?? defaultMigrationsDir();

  const migrations = await loadMigrations(directory);
  const connection = await connect(config);
  try {
    await ensureRegistry(connection);
    const [rows] = await connection.query<(AppliedRow & { applied_at: Date })[]>(
      'SELECT version, name, checksum, applied_at FROM schema_migration',
    );
    const applied = new Map(rows.map((row) => [row.version, row]));

    return migrations.map((migration) => {
      const record = applied.get(migration.version);
      return {
        version: migration.version,
        name: migration.name,
        applied: record !== undefined,
        appliedAt: record?.applied_at ?? null,
      };
    });
  } finally {
    await connection.end();
  }
}

// --- CLI -------------------------------------------------------------------

function usage(): string {
  return [
    'Usage: node dist/db/migrate.js <command>',
    '',
    'Commands:',
    '  up                Apply all pending migrations (default)',
    '  down --to <n>     Roll back every migration above version <n>',
    '  status            Show which migrations have been applied',
  ].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'up';
  const report: Reporter = (event) => {
    const stream = event.level === 'warn' ? console.error : console.log;
    stream(`migrate: ${event.message}`);
  };

  switch (command) {
    case 'up': {
      await migrateUp({ report });
      return 0;
    }
    case 'down': {
      const flagIndex = argv.indexOf('--to');
      if (flagIndex === -1 || argv[flagIndex + 1] === undefined) {
        console.error('migrate: "down" requires --to <version>, e.g. --to 0 to revert everything');
        return 2;
      }
      const target = Number(argv[flagIndex + 1]);
      if (!Number.isSafeInteger(target) || target < 0) {
        console.error(`migrate: invalid --to value "${argv[flagIndex + 1]}"`);
        return 2;
      }
      await migrateDown(target, { report });
      return 0;
    }
    case 'status': {
      for (const entry of await migrationStatus()) {
        const mark = entry.applied ? 'applied' : 'pending';
        const when = entry.appliedAt ? ` (${entry.appliedAt.toISOString()})` : '';
        console.log(
          `${String(entry.version).padStart(4, '0')} ${entry.name.padEnd(28)} ${mark}${when}`,
        );
      }
      return 0;
    }
    case '--help':
    case '-h':
    case 'help': {
      console.log(usage());
      return 0;
    }
    default: {
      console.error(`migrate: unknown command "${command}"\n\n${usage()}`);
      return 2;
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`migrate: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
