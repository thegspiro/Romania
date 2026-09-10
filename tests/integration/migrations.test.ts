/**
 * Migration mechanics.
 *
 * The rollback path is tested because an untested `.down.sql` is discovered
 * only when a rollback is already needed, which is the worst possible moment.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { databaseAvailable, testConfig } from './helpers.js';
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from '../../src/db/migrate.js';
import { createPool, queryOne, queryRows, type Pool } from '../../src/db/pool.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const available = await databaseAvailable();
const config = testConfig();
const options = { config, directory: MIGRATIONS_DIR };

// Derived from the files on disk rather than written out, so adding a
// migration does not require editing four assertions here -- and so these
// tests keep asserting "every migration", which is the actual property.
const ALL_VERSIONS = (await loadMigrations(MIGRATIONS_DIR)).map((entry) => entry.version);

describe('migration files', () => {
  it('every up-migration has a down-migration', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations) {
      expect(migration.downPath).toMatch(/\.down\.sql$/);
    }
  });

  it('versions are unique and ordered', async () => {
    const versions = (await loadMigrations(MIGRATIONS_DIR)).map((entry) => entry.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });
});

describe.skipIf(!available)('migration runner', () => {
  let pool: Pool;

  beforeAll(async () => {
    await migrateDown(0, options);
    pool = createPool(config);
  });

  afterAll(async () => {
    // Leave the database migrated, so a following suite finds a usable schema.
    await migrateUp(options);
    await pool.end();
  });

  it('applies every migration from an empty database', async () => {
    const applied = await migrateUp(options);
    expect(applied).toEqual(ALL_VERSIONS);

    const tables = await queryRows<RowDataPacket & { TABLE_NAME: string }>(
      pool,
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [config.DB_NAME],
    );
    const names = tables.map((row) => row.TABLE_NAME);
    expect(names).toContain('content_item');
    expect(names).toContain('source_detail');
    expect(names).toContain('admin_user');
    expect(names).toContain('job');
    expect(names).toContain('mention');
    expect(names).toContain('manuscript_detail');
    expect(names).toContain('manuscript_section');
    expect(names).toContain('manuscript_build');
  });

  it('adds the timeline columns 0006 introduces', async () => {
    // 0006 only ALTERs, so the table-name assertions above cannot see it.
    const columns = await queryRows<RowDataPacket & { TABLE_NAME: string; COLUMN_NAME: string }>(
      pool,
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('event_detail', 'mention')`,
      [config.DB_NAME],
    );
    const named = columns.map((row) => `${row.TABLE_NAME}.${row.COLUMN_NAME}`);

    expect(named).toContain('event_detail.start_precision');
    expect(named).toContain('event_detail.end_precision');
    expect(named).toContain('event_detail.is_circa');
    expect(named).toContain('event_detail.body_markdown');
    expect(named).toContain('event_detail.sort_date');
    expect(named).toContain('mention.block_index');
    // Kept for backward compatibility, not replaced.
    expect(named).toContain('event_detail.date_precision');
  });

  it('computes the chronological sort key in the database', async () => {
    // A generated column, so nothing in the application maintains it and it
    // cannot drift from the dates it is derived from.
    const row = await queryOne<RowDataPacket & { EXTRA: string }>(
      pool,
      `SELECT EXTRA FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'event_detail' AND COLUMN_NAME = 'sort_date'`,
      [config.DB_NAME],
    );
    expect(row?.EXTRA).toContain('GENERATED');
  });

  it('can re-run every up-migration against a schema that already has it', async () => {
    // MySQL commits implicitly around DDL, so a file that fails partway cannot
    // roll back and the version is never recorded -- the operator's only
    // recovery is to fix it and run it again. That makes re-runnability a
    // property of every up-migration, not a style preference, and it is
    // otherwise invisible until the day it is needed.
    //
    // Mirrors the runner's connection exactly: it is the only one in the
    // system with multipleStatements enabled, and a whole file is one query.
    const connection = await mysql.createConnection({
      host: config.DB_HOST,
      port: config.DB_PORT,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      database: config.DB_NAME,
      multipleStatements: true,
      charset: 'utf8mb4_0900_ai_ci',
      timezone: 'Z',
    });

    try {
      for (const migration of await loadMigrations(MIGRATIONS_DIR)) {
        const sql = await readFile(migration.upPath, 'utf8');
        await expect(
          connection.query(sql),
          `${migration.version} ${migration.name} is not re-runnable`,
        ).resolves.toBeDefined();
      }
    } finally {
      await connection.end();
    }
  });

  it('is a no-op when already up to date', async () => {
    expect(await migrateUp(options)).toEqual([]);
  });

  it('reports status for each migration', async () => {
    const status = await migrationStatus(options);
    expect(status.map((entry) => entry.version)).toEqual(ALL_VERSIONS);
    expect(status.every((entry) => entry.applied)).toBe(true);
    expect(status[0]?.appliedAt).toBeInstanceOf(Date);
  });

  it('creates tables with the expected charset and collation', async () => {
    // The accent-insensitive collation is what makes search find "Iasi" for
    // "Iași"; a table created with the server default would break that.
    const row = await queryOne<RowDataPacket & { TABLE_COLLATION: string }>(
      pool,
      `SELECT TABLE_COLLATION FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'content_item'`,
      [config.DB_NAME],
    );
    expect(row?.TABLE_COLLATION).toBe('utf8mb4_0900_ai_ci');
  });

  it('enforces slug uniqueness within a kind but not across kinds', async () => {
    await pool.query(
      `INSERT INTO content_item (kind, slug, title) VALUES ('source', 'shared', 'A Source')`,
    );
    // Same slug, different kind: allowed, because the URL prefixes differ.
    await expect(
      pool.query(
        `INSERT INTO content_item (kind, slug, title) VALUES ('essay', 'shared', 'An Essay')`,
      ),
    ).resolves.toBeDefined();
    // Same slug, same kind: rejected.
    await expect(
      pool.query(
        `INSERT INTO content_item (kind, slug, title) VALUES ('source', 'shared', 'Another')`,
      ),
    ).rejects.toThrow();

    await pool.query(`DELETE FROM content_item WHERE slug = 'shared'`);
  });

  it('defaults new content to private', async () => {
    // Nothing becomes public by accident.
    await pool.query(
      `INSERT INTO content_item (kind, slug, title) VALUES ('source', 'default-visibility', 'X')`,
    );
    const row = await queryOne<RowDataPacket & { visibility: string }>(
      pool,
      `SELECT visibility FROM content_item WHERE slug = 'default-visibility'`,
    );
    expect(row?.visibility).toBe('private');
    await pool.query(`DELETE FROM content_item WHERE slug = 'default-visibility'`);
  });

  it('enforces the place coordinate check constraints', async () => {
    await pool.query(
      `INSERT INTO content_item (id, kind, slug, title) VALUES (9001, 'place', 'a-place', 'A Place')`,
    );
    // A lone latitude is a bug, not a partial answer.
    await expect(
      pool.query('INSERT INTO place_detail (content_item_id, latitude) VALUES (9001, 45.0)'),
    ).rejects.toThrow();
    await expect(
      pool.query(
        'INSERT INTO place_detail (content_item_id, latitude, longitude) VALUES (9001, 200.0, 10.0)',
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        'INSERT INTO place_detail (content_item_id, latitude, longitude) VALUES (9001, 44.43, 26.10)',
      ),
    ).resolves.toBeDefined();

    await pool.query('DELETE FROM content_item WHERE id = 9001');
  });

  it('rejects a relationship from an item to itself', async () => {
    await pool.query(
      `INSERT INTO content_item (id, kind, slug, title) VALUES (9002, 'person', 'a-person', 'A Person')`,
    );
    await expect(
      pool.query(
        'INSERT INTO relationship (from_item_id, to_item_id, predicate_id) VALUES (9002, 9002, 1)',
      ),
    ).rejects.toThrow();
    await pool.query('DELETE FROM content_item WHERE id = 9002');
  });

  it('lets one pair hold two offices but still refuses an exact duplicate', async () => {
    // The widened unique key. Without the generated period_key folding NULL
    // to '', the undated pair below would be accepted twice, because MySQL
    // treats NULLs in a unique index as distinct.
    await pool.query(
      `INSERT INTO content_item (id, kind, slug, title)
       VALUES (9003, 'person', 'office-holder', 'Holder'),
              (9004, 'organization', 'the-ministry', 'Ministry')`,
    );
    const insert = `INSERT INTO relationship
        (from_item_id, to_item_id, predicate_id, role_title, start_date, end_date)
      VALUES (9003, 9004, 1, ?, ?, ?)`;

    await expect(
      pool.query(insert, ['Minister', '1937-01-01', '1938-01-01']),
    ).resolves.toBeDefined();
    await expect(
      pool.query(insert, ['Prime Minister', '1940-01-01', '1944-01-01']),
    ).resolves.toBeDefined();
    // The same office over the same period is the same claim twice.
    await expect(pool.query(insert, ['Minister', '1937-01-01', '1938-01-01'])).rejects.toThrow();

    await expect(pool.query(insert, [null, null, null])).resolves.toBeDefined();
    await expect(pool.query(insert, [null, null, null])).rejects.toThrow();

    await pool.query('DELETE FROM content_item WHERE id IN (9003, 9004)');
  });

  it('enforces the relationship period and role check constraints', async () => {
    await pool.query(
      `INSERT INTO content_item (id, kind, slug, title)
       VALUES (9005, 'person', 'checked-person', 'Person'),
              (9006, 'organization', 'checked-org', 'Org')`,
    );

    // An office that ended before it began is a data-entry error, not a fact.
    await expect(
      pool.query(
        `INSERT INTO relationship (from_item_id, to_item_id, predicate_id, start_date, end_date)
         VALUES (9005, 9006, 1, '1944-01-01', '1940-01-01')`,
      ),
    ).rejects.toThrow();

    // '' and NULL would be two spellings of "no office recorded".
    await expect(
      pool.query(
        `INSERT INTO relationship (from_item_id, to_item_id, predicate_id, role_title)
         VALUES (9005, 9006, 1, '')`,
      ),
    ).rejects.toThrow();

    await pool.query('DELETE FROM content_item WHERE id IN (9005, 9006)');
  });

  it('seeds the relationship vocabulary', async () => {
    const row = await queryOne<RowDataPacket & { total: number }>(
      pool,
      'SELECT COUNT(*) AS total FROM relationship_predicate',
    );
    expect(row?.total).toBeGreaterThan(0);
  });

  it('rolls every migration back', async () => {
    const reverted = await migrateDown(0, options);
    expect(reverted).toEqual([...ALL_VERSIONS].reverse());

    const tables = await queryRows<RowDataPacket & { TABLE_NAME: string }>(
      pool,
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [config.DB_NAME],
    );
    const names = tables.map((row) => row.TABLE_NAME);
    expect(names).not.toContain('content_item');
    expect(names).not.toContain('admin_user');
    expect(names).not.toContain('mention');
    expect(names).not.toContain('manuscript_section');
    // The registry survives, so re-applying knows where it stands.
    expect(names).toContain('schema_migration');
  });

  it('rolls back partially to a target version', async () => {
    await migrateUp(options);
    const reverted = await migrateDown(1, options);
    expect(reverted).toEqual(ALL_VERSIONS.filter((version) => version > 1).reverse());

    const status = await migrationStatus(options);
    expect(status.find((entry) => entry.version === 1)?.applied).toBe(true);
    expect(status.find((entry) => entry.version === 2)?.applied).toBe(false);
  });

  it('rejects a negative rollback target', async () => {
    await expect(migrateDown(-1, options)).rejects.toThrow(TypeError);
  });
});
