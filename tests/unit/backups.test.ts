/**
 * Retention parsing.
 *
 * `--keep` is the one number an operator types into a backup command, and the
 * mistake it invites is typing a number of days. Both bounds are the worker's,
 * restated here so a typo fails at the prompt rather than as a job that errors
 * minutes later with nothing written.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP,
  InvalidRetentionError,
  MAX_KEEP,
  MIN_KEEP,
  parseRetention,
} from '../../src/content/backups.js';

describe('parseRetention', () => {
  it('defaults when the flag is absent', () => {
    expect(parseRetention(undefined)).toBe(DEFAULT_KEEP);
  });

  it('accepts the bounds the worker accepts', () => {
    expect(parseRetention(String(MIN_KEEP))).toBe(MIN_KEEP);
    expect(parseRetention(String(MAX_KEEP))).toBe(MAX_KEEP);
  });

  it('rejects zero and anything past the ceiling', () => {
    expect(() => parseRetention('0')).toThrow(InvalidRetentionError);
    expect(() => parseRetention(String(MAX_KEEP + 1))).toThrow(InvalidRetentionError);
  });

  it('rejects what is not a whole positive number', () => {
    // "-1" and "7.5" are the plausible typos. 'true' is what parseFlags gives
    // for a bare `--keep` at the end of the argument list, or one followed by
    // another flag, so it reaches here as a value rather than as undefined.
    for (const bad of ['-1', '7.5', 'fourteen', 'true', '', ' ', '1e3', '0x10']) {
      expect(() => parseRetention(bad), `expected ${JSON.stringify(bad)} to be rejected`).toThrow(
        InvalidRetentionError,
      );
    }
  });

  it('explains that the number is backups, not days', () => {
    // The whole reason the message is long: the flag reads like a duration.
    expect(() => parseRetention('999')).toThrow(/not a number of days/);
  });
});
