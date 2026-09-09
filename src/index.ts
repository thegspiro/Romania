/**
 * Process entry point.
 *
 * Configuration is validated before anything is opened, so a misconfigured
 * container fails immediately and visibly rather than serving requests with
 * insecure cookies or an unusable WebAuthn origin.
 */
import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildServer } from './http/server.js';
import { sweepExpiredSessions } from './auth/session.js';
import { pruneLoginAttempts } from './auth/repository.js';

/** How often expired sessions and stale login attempts are cleared out. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw error;
  }

  const pool = createPool(config);
  const app = await buildServer({ config, pool });

  const sweep = setInterval(() => {
    void (async () => {
      try {
        const sessions = await sweepExpiredSessions(pool);
        const attempts = await pruneLoginAttempts(pool);
        if (sessions > 0 || attempts > 0) {
          app.log.info({ sessions, attempts }, 'swept expired records');
        }
      } catch (error) {
        app.log.error({ err: error }, 'sweep failed');
      }
    })();
  }, SWEEP_INTERVAL_MS);
  // Do not hold the event loop open for the timer alone.
  sweep.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    void (async () => {
      clearInterval(sweep);
      try {
        // Stop accepting connections and let in-flight requests finish before
        // the pool goes away, so no request dies mid-transaction.
        await app.close();
        await pool.end();
        process.exit(0);
      } catch (error) {
        app.log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
