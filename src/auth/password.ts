/**
 * Password hashing.
 *
 * Argon2id with parameters supplied by configuration. The parameters are
 * encoded into the PHC hash string itself, so raising the cost later does not
 * invalidate existing passwords -- `needsRehash` detects the difference and
 * the caller can upgrade the stored hash on the next successful login.
 */
import { hash, parseOptions, verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';
import type { Config } from '../config.js';

/**
 * Argon2id.
 *
 * `@node-rs/argon2` declares `Algorithm` as an ambient `const enum`, which
 * cannot be imported as a value while `verbatimModuleSyntax` is on. The
 * numeric value is fixed by the library's public API (Argon2d 0, Argon2i 1,
 * Argon2id 2) and `password.test.ts` asserts that hashes really are Argon2id,
 * so a change upstream would fail the suite rather than silently downgrade
 * the algorithm.
 */
const ARGON2ID = 2 as Algorithm;

export interface PasswordPolicy {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * Minimum accepted password length.
 *
 * NIST SP 800-63B recommends length over composition rules: a long
 * passphrase resists guessing far better than a short string forced to
 * contain a symbol, and composition rules push people towards predictable
 * substitutions.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Maximum accepted password length. Argon2 has no practical input limit; this
 * exists so an enormous submitted body cannot be turned into CPU and memory
 * load by the hashing function.
 */
export const MAX_PASSWORD_LENGTH = 1024;

export function policyFromConfig(config: Config): PasswordPolicy {
  return {
    memoryCost: config.ARGON2_MEMORY_KIB,
    timeCost: config.ARGON2_TIME_COST,
    parallelism: config.ARGON2_PARALLELISM,
  };
}

export class WeakPasswordError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

/** Throws WeakPasswordError when the password fails policy. */
export function assertPasswordAcceptable(password: string): void {
  // Count Unicode code points, not UTF-16 units, so a passphrase using
  // non-BMP characters is not credited double.
  const length = [...password].length;

  if (length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters. A memorable ` +
        'passphrase of several words is stronger than a short complex string.',
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (password.trim() === '') {
    throw new WeakPasswordError('Password must not be only whitespace.');
  }
}

export async function hashPassword(password: string, policy: PasswordPolicy): Promise<string> {
  assertPasswordAcceptable(password);
  return hash(password, {
    algorithm: ARGON2ID,
    memoryCost: policy.memoryCost,
    timeCost: policy.timeCost,
    parallelism: policy.parallelism,
  });
}

/**
 * Verifies a password against a stored PHC hash.
 *
 * Returns false rather than throwing on a malformed stored hash: a corrupted
 * row must fail the login, not crash the request handler.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** True when the stored hash was produced with weaker parameters than current policy. */
export function needsRehash(storedHash: string, policy: PasswordPolicy): boolean {
  try {
    const options = parseOptions(storedHash);
    return (
      options.algorithm !== ARGON2ID ||
      options.memoryCost < policy.memoryCost ||
      options.timeCost < policy.timeCost ||
      options.parallelism !== policy.parallelism
    );
  } catch {
    // Unparseable: treat as needing replacement.
    return true;
  }
}
