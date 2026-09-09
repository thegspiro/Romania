/**
 * Administrative command line.
 *
 * This is the break-glass path. The web interface cannot create the first
 * account (there is nobody to authorise it) and cannot help when every passkey
 * and recovery code is gone. Both are handled here, which requires shell
 * access to the container -- an authorisation boundary the network cannot
 * cross.
 *
 * Usage (inside the container):
 *   node dist/cli/admin.js create-admin [--username u] [--name "Full Name"]
 *   node dist/cli/admin.js reset-password --username u
 *   node dist/cli/admin.js list-passkeys --username u
 *   node dist/cli/admin.js revoke-passkey --username u --id 3
 *   node dist/cli/admin.js recovery-codes --username u
 *   node dist/cli/admin.js sessions-revoke --username u
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { createPool, type Pool } from '../db/pool.js';
import {
  countUsers,
  createUser,
  deleteCredential,
  findUserByUsername,
  listCredentials,
  replaceRecoveryCodes,
  updatePasswordHash,
} from '../auth/repository.js';
import {
  assertPasswordAcceptable,
  hashPassword,
  policyFromConfig,
  WeakPasswordError,
} from '../auth/password.js';
import { generateRecoveryCodes, hashRecoveryCode } from '../auth/recovery.js';
import { destroyUserSessions } from '../auth/session.js';
import { recordAudit } from '../content/audit.js';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/i;

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, 'true');
    } else {
      flags.set(name, next);
      index += 1;
    }
  }
  return flags;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Reads a password without echoing it.
 *
 * Passing a password on the command line would put it in the shell history and
 * in the process list, where any other user on the host can read it.
 */
async function promptSecret(question: string): Promise<string> {
  if (!stdin.isTTY) {
    // Non-interactive: read one line from stdin so the command stays usable
    // in a script, e.g. `printf '%s\n' "$PW" | admin reset-password`.
    const rl = createInterface({ input: stdin });
    try {
      for await (const line of rl) return line;
      return '';
    } finally {
      rl.close();
    }
  }

  stdout.write(question);
  const previouslyRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve) => {
    let value = '';
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const character of text) {
        if (character === '\r' || character === '\n') {
          stdin.setRawMode(previouslyRaw);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\x03') {
          // Ctrl-C
          stdin.setRawMode(previouslyRaw);
          stdout.write('\n');
          process.exit(130);
        }
        if (character === '\x7f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore the remaining control characters rather than storing them.
        if (character < ' ') continue;
        value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function readNewPassword(): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await promptSecret('New password: ');
    try {
      assertPasswordAcceptable(first);
    } catch (error) {
      console.error(error instanceof WeakPasswordError ? error.message : String(error));
      continue;
    }

    if (!stdin.isTTY) return first;

    const second = await promptSecret('Repeat password: ');
    if (first !== second) {
      console.error('Passwords did not match.');
      continue;
    }
    return first;
  }
  throw new Error('Giving up after three attempts.');
}

async function issueRecoveryCodes(pool: Pool, config: Config, userId: number): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const policy = policyFromConfig(config);
  const hashes: string[] = [];
  for (const code of codes) {
    hashes.push(await hashRecoveryCode(code, policy));
  }
  await replaceRecoveryCodes(pool, userId, hashes);
  return codes;
}

function printRecoveryCodes(codes: string[]): void {
  console.log('');
  console.log('  Recovery codes — each works once, and this is the only time they are shown:');
  console.log('');
  for (const code of codes) console.log(`    ${code}`);
  console.log('');
  console.log('  Store them somewhere other than the vault holding your passkey. If that');
  console.log('  vault is what you lose, a code kept inside it is no help.');
  console.log('');
}

async function requireUser(pool: Pool, username: string) {
  const user = await findUserByUsername(pool, username);
  if (user === null) throw new Error(`No such user: ${username}`);
  return user;
}

function usage(): string {
  return [
    'Usage: node dist/cli/admin.js <command> [options]',
    '',
    'Commands:',
    '  create-admin       Create the administrator account (first run)',
    '  reset-password     Set a new password for an account',
    '  list-passkeys      List registered passkeys',
    '  revoke-passkey     Remove one passkey by id',
    '  recovery-codes     Generate a fresh set of recovery codes',
    '  sessions-revoke    Sign out every session for an account',
    '',
    'Options:',
    '  --username <name>  Account to act on',
    '  --name <text>      Display name (create-admin only)',
  ].join('\n');
}

async function run(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return command === undefined ? 2 : 0;
  }

  const config = loadConfig();
  const flags = parseFlags(argv.slice(1));
  const pool = createPool(config);

  try {
    switch (command) {
      case 'create-admin': {
        if ((await countUsers(pool)) > 0 && flags.get('force') !== 'true') {
          console.error(
            'An account already exists. Use reset-password, or pass --force to add another.',
          );
          return 1;
        }

        const username = (flags.get('username') ?? (await prompt('Username: '))).trim();
        if (!USERNAME_PATTERN.test(username)) {
          console.error(
            'Username must be 3-64 characters: letters, digits, dot, underscore or hyphen.',
          );
          return 1;
        }
        if ((await findUserByUsername(pool, username)) !== null) {
          console.error(`That username is already taken: ${username}`);
          return 1;
        }

        const displayName =
          (flags.get('name') ?? (await prompt(`Display name [${username}]: `))) || username;
        const password = await readNewPassword();

        const userId = await createUser(pool, {
          username,
          displayName,
          passwordHash: await hashPassword(password, policyFromConfig(config)),
        });
        const codes = await issueRecoveryCodes(pool, config, userId);
        await recordAudit(pool, { actor: 'cli', action: 'admin.created', itemId: userId });

        console.log(`\nCreated administrator "${username}".`);
        printRecoveryCodes(codes);
        console.log(`  Sign in at ${config.PUBLIC_BASE_URL}/login and register a passkey.`);
        console.log('');
        return 0;
      }

      case 'reset-password': {
        const username = (flags.get('username') ?? (await prompt('Username: '))).trim();
        const user = await requireUser(pool, username);
        const password = await readNewPassword();

        await updatePasswordHash(
          pool,
          user.id,
          await hashPassword(password, policyFromConfig(config)),
        );
        // A password reset must not leave old sessions authenticated: the
        // reason for resetting is usually that one may be in the wrong hands.
        const revoked = await destroyUserSessions(pool, user.id);
        await recordAudit(pool, { actor: 'cli', action: 'auth.password.changed', itemId: user.id });

        console.log(`Password updated for "${username}". Revoked ${revoked} session(s).`);
        return 0;
      }

      case 'list-passkeys': {
        const username = (flags.get('username') ?? (await prompt('Username: '))).trim();
        const user = await requireUser(pool, username);
        const credentials = await listCredentials(pool, user.id);

        if (credentials.length === 0) {
          console.log('No passkeys registered.');
          return 0;
        }
        for (const credential of credentials) {
          const used = credential.lastUsedAt?.toISOString().slice(0, 10) ?? 'never';
          const kind = credential.backedUp ? 'synced' : 'single-device';
          console.log(
            `${String(credential.id).padStart(4)}  ${credential.label.padEnd(28)} ${kind.padEnd(14)} last used ${used}`,
          );
        }
        return 0;
      }

      case 'revoke-passkey': {
        const username = (flags.get('username') ?? (await prompt('Username: '))).trim();
        const user = await requireUser(pool, username);
        const id = Number(flags.get('id') ?? (await prompt('Passkey id: ')));
        if (!Number.isSafeInteger(id) || id <= 0) {
          console.error('Pass a numeric --id from list-passkeys.');
          return 1;
        }

        if (!(await deleteCredential(pool, user.id, id))) {
          console.error(`No passkey ${id} belongs to "${username}".`);
          return 1;
        }
        await recordAudit(pool, { actor: 'cli', action: 'auth.passkey.revoked', itemId: id });
        console.log(`Removed passkey ${id}.`);
        return 0;
      }

      case 'recovery-codes': {
        const username = (flags.get('username') ?? (await prompt('Username: '))).trim();
        const user = await requireUser(pool, username);
        const codes = await issueRecoveryCodes(pool, config, user.id);
        await recordAudit(pool, {
          actor: 'cli',
          action: 'auth.recovery.regenerated',
          itemId: user.id,
        });

        console.log(`Previous codes for "${username}" are now invalid.`);
        printRecoveryCodes(codes);
        return 0;
      }

      case 'sessions-revoke': {
        const username = (flags.get('username') ?? (await prompt('Username: '))).trim();
        const user = await requireUser(pool, username);
        const revoked = await destroyUserSessions(pool, user.id);
        console.log(`Revoked ${revoked} session(s) for "${username}".`);
        return 0;
      }

      default: {
        console.error(`Unknown command "${command}"\n\n${usage()}`);
        return 2;
      }
    }
  } finally {
    await pool.end();
  }
}

run(process.argv.slice(2))
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
