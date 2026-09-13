/**
 * Deployment preflight.
 *
 * Answers one question -- "is this install actually ready?" -- before the
 * operator opens the firewall, and answers it in the order things go wrong.
 *
 * Everything here is already enforced somewhere: the config is validated at
 * startup, the database is waited on by the entrypoint, storage is checked
 * before the service starts. What none of those do is report the state of the
 * whole install in one place while it is still cheap to fix, or mention the
 * step that has no enforcement at all -- that an administrator account has to
 * be created by hand, which is easy to finish an install without noticing.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { createStorageBackend } from '../files/backend.js';
import { createPool, type Pool } from '../db/pool.js';
import { migrationStatus } from '../db/migrate.js';
import { countUsers } from '../auth/repository.js';

type Status = 'ok' | 'warn' | 'fail' | 'skip';

interface Check {
  status: Status;
  label: string;
  detail: string;
}

const MARK: Record<Status, string> = { ok: ' ok ', warn: 'warn', fail: 'FAIL', skip: 'skip' };

function render(check: Check): void {
  const stream = check.status === 'fail' ? console.error : console.log;
  stream(`[${MARK[check.status]}] ${check.label.padEnd(16)} ${check.detail}`);
}

/** A real write, because a mode bit says nothing about a read-only mount. */
async function checkWritable(label: string, path: string): Promise<Check> {
  const probe = join(path, `.preflight-probe.${process.pid}`);
  try {
    await mkdir(path, { recursive: true });
    await writeFile(probe, '');
    await rm(probe, { force: true });
    return { status: 'ok', label, detail: `${path} is writable` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'fail', label, detail: `${path} is not writable: ${reason}` };
  }
}

/**
 * That the configured storage backend actually answers.
 *
 * For `s3` this is a HeadBucket, which fails distinctly for a wrong region, a
 * missing bucket and a credential that cannot see it -- all three of which
 * otherwise present as a working service that loses the first upload.
 */
async function checkStorage(config: Config): Promise<Check> {
  const backend = createStorageBackend(config);
  try {
    await backend.check();
    return { status: 'ok', label: 'storage', detail: `${backend.describe()} is reachable` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 'fail',
      label: 'storage',
      detail: `${backend.describe()} is not usable: ${reason}`,
    };
  }
}

async function checkDatabase(pool: Pool, config: Config): Promise<Check> {
  try {
    await pool.query('SELECT 1');
    return {
      status: 'ok',
      label: 'database',
      detail: `connected to ${config.DB_NAME} at ${config.DB_HOST}:${config.DB_PORT}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'fail', label: 'database', detail: reason };
  }
}

async function checkMigrations(config: Config): Promise<Check> {
  try {
    const entries = await migrationStatus({ config });
    const pending = entries.filter((entry) => !entry.applied);
    if (pending.length === 0) {
      return {
        status: 'ok',
        label: 'migrations',
        detail: `all ${entries.length} applied`,
      };
    }
    const names = pending.map((entry) => entry.name).join(', ');
    return {
      status: 'warn',
      label: 'migrations',
      // Not a failure: the web role applies these on start, so pending here is
      // the normal state of an install that has not been started yet.
      detail: `${pending.length} pending (${names}) -- the web role applies them on start`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'fail', label: 'migrations', detail: reason };
  }
}

async function checkAdministrator(pool: Pool): Promise<Check> {
  try {
    const total = await countUsers(pool);
    if (total > 0) {
      return { status: 'ok', label: 'administrator', detail: `${total} account(s) exist` };
    }
    return {
      status: 'warn',
      label: 'administrator',
      detail:
        'none yet -- run: docker compose exec web /app/scripts/entrypoint.sh admin create-admin',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'fail', label: 'administrator', detail: reason };
  }
}

/**
 * Reported rather than judged. Both of these are already validated at load,
 * and printing them back is what lets an operator catch the value that is
 * valid but not what they meant -- a staging hostname, or a stale port.
 */
function describeIdentity(config: Config): Check[] {
  return [
    {
      status: 'ok',
      label: 'public url',
      detail: config.PUBLIC_BASE_URL,
    },
    {
      status: 'ok',
      label: 'passkeys',
      detail: `relying party "${config.WEBAUTHN_RP_ID}", origins: ${config.WEBAUTHN_ORIGINS.join(', ')}`,
    },
    {
      status: config.ALLOW_SEARCH_INDEXING ? 'warn' : 'ok',
      label: 'indexing',
      detail: config.ALLOW_SEARCH_INDEXING
        ? 'ALLOW_SEARCH_INDEXING is true -- public pages may be crawled and archived'
        : 'disabled, so nothing public is crawled',
    },
  ];
}

async function run(): Promise<number> {
  const config = loadConfig();
  const checks: Check[] = [
    { status: 'ok', label: 'configuration', detail: `valid, NODE_ENV=${config.NODE_ENV}` },
    ...describeIdentity(config),
  ];

  const pool = createPool(config);
  try {
    const database = await checkDatabase(pool, config);
    checks.push(database);

    if (database.status === 'ok') {
      checks.push(await checkMigrations(config));
      checks.push(await checkAdministrator(pool));
    } else {
      // Both of these need the connection that just failed, and running them
      // anyway would print the same error three times over one cause. Skipped
      // rather than failed: the report should have exactly as many failures as
      // there are things to fix.
      for (const label of ['migrations', 'administrator']) {
        checks.push({
          status: 'skip',
          label,
          detail: 'not checked -- needs a working database connection',
        });
      }
    }
  } finally {
    await pool.end();
  }

  checks.push(await checkStorage(config));
  // STORAGE_ROOT stays required under either backend: uploads are hashed into
  // a local scratch file before they can be addressed by content, and the
  // worker needs somewhere to put a file Pandoc can read.
  checks.push(await checkWritable('scratch', config.STORAGE_ROOT));
  checks.push(await checkWritable('backups', process.env['BACKUP_ROOT'] ?? '/data/backups'));

  for (const check of checks) render(check);

  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;

  console.log('');
  if (failed > 0) {
    console.error(`preflight: ${failed} check(s) failed -- this install is not ready.`);
    return 1;
  }
  console.log(
    warned > 0
      ? `preflight: ready, with ${warned} thing(s) to look at above.`
      : 'preflight: ready.',
  );
  return 0;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
