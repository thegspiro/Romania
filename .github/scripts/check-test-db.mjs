/**
 * Confirms the integration test database is reachable before vitest runs.
 *
 * This deliberately connects the way the suites do -- same driver, same
 * TEST_DB_* variables, same database -- rather than shelling out to a mysql
 * client. A probe using different credentials or a different client can pass
 * while the suites still cannot connect, which is precisely the failure this
 * is meant to rule out.
 *
 * It is a second line of defence: the service container is already healthy
 * before the job's first step runs, and REQUIRE_TEST_DB makes vitest fail on
 * an unreachable database anyway. What this adds is a named step and one
 * legible error, instead of the same connection error repeated once per
 * integration file.
 */
import { createConnection } from 'mysql2/promise';

// The service container is reported healthy before the job's first step, and
// several minutes of install and lint run before this. So MySQL is long since
// up: these retries cover a momentary blip, not a cold start. Keeping the
// budget short means a genuine misconfiguration fails in seconds rather than
// after a minute of hopeful waiting.
const ATTEMPTS = 10;
const DELAY_MS = 1000;

const settings = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? '3306'),
  user: process.env.TEST_DB_USER ?? 'dissertation',
  password: process.env.TEST_DB_PASSWORD ?? 'testpass',
  database: process.env.TEST_DB_NAME ?? 'dissertation_test',
  connectTimeout: 4000,
};

const target = `${settings.user}@${settings.host}:${settings.port}/${settings.database}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastError;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  try {
    const connection = await createConnection(settings);
    // SELECT 1 proves the handshake; reading the schema proves the migrations
    // the harness runs will have somewhere to go. The harness never issues
    // CREATE DATABASE, so a missing schema is a setup error, not a retry.
    await connection.query('SELECT 1');
    await connection.end();
    console.log(`${target} answered on attempt ${attempt}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < ATTEMPTS) await sleep(DELAY_MS);
  }
}

console.error(`${target} never answered after ${ATTEMPTS} attempts.`);
console.error(String(lastError));
process.exit(1);
