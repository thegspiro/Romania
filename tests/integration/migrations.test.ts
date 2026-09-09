/**
 * Migration mechanics.
 *
 * The rollback path is tested because an untested `.down.sql` is discovered
 * only when a rollback is already needed, which is the worst possible moment.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { databaseAvailable, testConfig } from './helpers.js';
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from '../../src/db/migrate.js';
import { createPool, queryOne, queryRows, type Pool } from '../../src/db/pool.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const available = await databaseAvailable();
const config = testConfig();
const options = { config, directory: MIGRATIONS_DIR };

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
    expect(applied).toEqual([1, 2, 3]);

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
  });

  it('is a no-op when already up to date', async () => {
    expect(await migrateUp(options)).toEqual([]);
  });

  it('reports status for each migration', async () => {
    const status = await migrationStatus(options);
    expect(status).toHaveLength(3);
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

  it('seeds the relationship vocabulary', async () => {
    const row = await queryOne<RowDataPacket & { total: number }>(
      pool,
      'SELECT COUNT(*) AS total FROM relationship_predicate',
    );
    expect(row?.total).toBeGreaterThan(0);
  });

  it('rolls every migration back', async () => {
    const reverted = await migrateDown(0, options);
    expect(reverted).toEqual([3, 2, 1]);

    const tables = await queryRows<RowDataPacket & { TABLE_NAME: string }>(
      pool,
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [config.DB_NAME],
    );
    const names = tables.map((row) => row.TABLE_NAME);
    expect(names).not.toContain('content_item');
    expect(names).not.toContain('admin_user');
    // The registry survives, so re-applying knows where it stands.
    expect(names).toContain('schema_migration');
  });

  it('rolls back partially to a target version', async () => {
    await migrateUp(options);
    const reverted = await migrateDown(1, options);
    expect(reverted).toEqual([3, 2]);

    const status = await migrationStatus(options);
    expect(status.find((entry) => entry.version === 1)?.applied).toBe(true);
    expect(status.find((entry) => entry.version === 2)?.applied).toBe(false);
  });

  it('rejects a negative rollback target', async () => {
    await expect(migrateDown(-1, options)).rejects.toThrow(TypeError);
  });
});
