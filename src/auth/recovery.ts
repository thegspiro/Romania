/**
 * Single-use recovery codes.
 *
 * These exist because the site is the only copy of years of research and the
 * second factor can be lost: a phone is replaced, a vault is locked out, a
 * hardware key is left in a drawer in another country. Ten codes, shown once,
 * are the documented way back in.
 *
 * Codes are generated with 100 bits of entropy from a Crockford-style
 * alphabet that omits the characters people transcribe wrongly (I, L, O, U),
 * because these get written down on paper.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, type PasswordPolicy } from './password.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 4;
const GROUP_LENGTH = 5;

export const RECOVERY_CODE_COUNT = 10;

/**
 * Generates one code, formatted in hyphenated groups for legible transcription.
 * 20 characters from a 32-symbol alphabet is 100 bits of entropy.
 */
export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let text = '';
    for (let index = 0; index < GROUP_LENGTH; index += 1) {
      // randomInt draws from the CSPRNG without modulo bias.
      text += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(text);
  }
  return groups.join('-');
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/**
 * Normalises a code as typed: case, spacing and hyphens are not significant,
 * and the two most common transcription mistakes are corrected.
 */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export async function hashRecoveryCode(code: string, policy: PasswordPolicy): Promise<string> {
  // Hashed with the same Argon2id policy as passwords. Codes are high-entropy
  // so a fast hash would be defensible, but there is no reason to introduce a
  // second, weaker standard for a credential that grants full access.
  //
  // A normalised code is 20 characters, comfortably above the minimum length
  // the password policy enforces.
  return hashPassword(normalizeRecoveryCode(code), policy);
}

/**
 * Finds which stored code matches the submitted one.
 *
 * Every unused code is checked even after a match is found, so the work done
 * does not reveal the matching code's position. The caller must still call
 * `consumeRecoveryCode` to spend it.
 */
export async function findMatchingRecoveryCode(
  submitted: string,
  stored: readonly { id: number; codeHash: string }[],
): Promise<number | null> {
  const normalized = normalizeRecoveryCode(submitted);
  let matchedId: number | null = null;

  for (const candidate of stored) {
    const isMatch = await verifyPassword(candidate.codeHash, normalized);
    if (isMatch && matchedId === null) {
      matchedId = candidate.id;
    }
  }

  return matchedId;
}

/** Constant-time equality for two already-normalised codes. */
export function recoveryCodesEqual(a: string, b: string): boolean {
  const left = Buffer.from(normalizeRecoveryCode(a), 'utf8');
  const right = Buffer.from(normalizeRecoveryCode(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
