import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  assertPasswordAcceptable,
  hashPassword,
  needsRehash,
  verifyPassword,
  WeakPasswordError,
} from '../../src/auth/password.js';
import {
  findMatchingRecoveryCode,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../../src/auth/recovery.js';
import { csrfTokenMatches, hashToken, packIpAddress } from '../../src/auth/session.js';
import { signCountLooksCloned } from '../../src/auth/webauthn.js';

// Deliberately cheap so the suite stays fast; production values come from
// configuration and are far higher.
const policy = { memoryCost: 8192, timeCost: 1, parallelism: 1 };

describe('password hashing', () => {
  it('produces an Argon2id PHC string and verifies it', async () => {
    const hash = await hashPassword('correct horse battery staple', policy);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password entirely')).toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const [first, second] = await Promise.all([
      hashPassword('correct horse battery staple', policy),
      hashPassword('correct horse battery staple', policy),
    ]);
    expect(first).not.toBe(second);
  });

  it('returns false rather than throwing on a corrupted stored hash', async () => {
    // A damaged row must fail the login, not crash the request handler.
    expect(await verifyPassword('not-a-phc-string', 'anything at all')).toBe(false);
    expect(await verifyPassword('', 'anything at all')).toBe(false);
  });

  it('enforces length over composition rules', () => {
    expect(() => assertPasswordAcceptable('short')).toThrow(WeakPasswordError);
    expect(() => assertPasswordAcceptable('a'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
    expect(() => assertPasswordAcceptable('              ')).toThrow(WeakPasswordError);
    expect(() => assertPasswordAcceptable('x'.repeat(2000))).toThrow(WeakPasswordError);
  });

  it('counts code points, not UTF-16 units', () => {
    // Twelve emoji are twelve characters, not twenty-four.
    expect(() => assertPasswordAcceptable('😀'.repeat(11))).toThrow(WeakPasswordError);
    expect(() => assertPasswordAcceptable('😀'.repeat(12))).not.toThrow();
  });

  it('detects a hash weaker than current policy', async () => {
    const weak = await hashPassword('correct horse battery staple', policy);
    expect(needsRehash(weak, policy)).toBe(false);
    expect(needsRehash(weak, { ...policy, memoryCost: 65536 })).toBe(true);
    expect(needsRehash('garbage', policy)).toBe(true);
  });
});

describe('recovery codes', () => {
  it('generates the documented number of formatted codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJ-NP-TV-Z]{5}(-[0-9A-HJ-NP-TV-Z]{5}){3}$/);
    }
  });

  it('omits the characters people transcribe wrongly', () => {
    // These are written on paper; I/L/O/U are the usual misreadings.
    const sample = Array.from({ length: 200 }, () => generateRecoveryCode()).join('');
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it('normalises case, spacing and the usual misreadings', () => {
    const canonical = normalizeRecoveryCode('ABCDE-FGHJK-MNPQR-STVWX');
    expect(normalizeRecoveryCode('abcde fghjk mnpqr stvwx')).toBe(canonical);
    expect(normalizeRecoveryCode('ABCDEFGHJKMNPQRSTVWX')).toBe(canonical);
    // O read as zero, I and L read as one.
    expect(normalizeRecoveryCode('O0I1L')).toBe('00111');
  });

  it('matches a stored code however it was typed', async () => {
    const code = generateRecoveryCode();
    const stored = [
      { id: 1, codeHash: await hashRecoveryCode(generateRecoveryCode(), policy) },
      { id: 2, codeHash: await hashRecoveryCode(code, policy) },
    ];

    expect(await findMatchingRecoveryCode(code, stored)).toBe(2);
    expect(await findMatchingRecoveryCode(code.toLowerCase().replace(/-/g, ' '), stored)).toBe(2);
    expect(await findMatchingRecoveryCode(generateRecoveryCode(), stored)).toBeNull();
  });

  it('returns null against an empty code list', async () => {
    expect(await findMatchingRecoveryCode('ABCDE-FGHJK-MNPQR-STVWX', [])).toBeNull();
  });
});

describe('session helpers', () => {
  it('hashes the cookie token, so the database never holds a live token', () => {
    const digest = hashToken('a-token');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('a-token');
    expect(hashToken('a-token')).toBe(digest);
  });

  it('compares CSRF tokens safely and rejects non-strings', () => {
    expect(csrfTokenMatches('abc123', 'abc123')).toBe(true);
    expect(csrfTokenMatches('abc123', 'abc124')).toBe(false);
    expect(csrfTokenMatches('abc123', 'abc1234')).toBe(false);
    expect(csrfTokenMatches('abc123', undefined)).toBe(false);
    expect(csrfTokenMatches('abc123', ['abc123'])).toBe(false);
    expect(csrfTokenMatches('abc123', { toString: () => 'abc123' })).toBe(false);
  });

  it('packs IPv4 and IPv6 addresses for storage', () => {
    expect(packIpAddress('203.0.113.4')).toEqual(Buffer.from([203, 0, 113, 4]));
    expect(packIpAddress('::1')?.length).toBe(16);
    expect(packIpAddress('2001:db8::1')?.length).toBe(16);
  });

  it('stores an IPv4-mapped IPv6 address as its IPv4 form', () => {
    // So rate limiting groups the same client together however it connected.
    expect(packIpAddress('::ffff:203.0.113.4')).toEqual(Buffer.from([203, 0, 113, 4]));
  });

  it('returns null for anything unparseable', () => {
    // A malformed X-Forwarded-For must not be able to break login.
    expect(packIpAddress('not an address')).toBeNull();
    expect(packIpAddress('999.1.1.1')).toBeNull();
    expect(packIpAddress(undefined)).toBeNull();
    expect(packIpAddress('')).toBeNull();
  });
});

describe('passkey signature counter', () => {
  it('accepts authenticators that never increment', () => {
    // Cloud-synced passkeys, Bitwarden among them, always report zero.
    expect(signCountLooksCloned(0, 0)).toBe(false);
  });

  it('accepts a counter that advances', () => {
    expect(signCountLooksCloned(5, 6)).toBe(false);
  });

  it('flags a counter that stalls or goes backwards', () => {
    expect(signCountLooksCloned(5, 5)).toBe(true);
    expect(signCountLooksCloned(5, 4)).toBe(true);
  });
});
