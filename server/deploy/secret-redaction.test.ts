import { describe, it, expect } from 'vitest';
import { createSecretRedactor, isFullyRedactable, REDACTED } from './secret-redaction.js';

describe('createSecretRedactor', () => {
  it('masks every occurrence of a value', () => {
    const redact = createSecretRedactor(['hunter22']);
    expect(redact('a hunter22 b hunter22')).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it('masks each line of a multi-line value', () => {
    const redact = createSecretRedactor(['-----BEGIN KEY-----\nAAAABBBBCCCC\n-----END KEY-----']);
    expect(redact('AAAABBBBCCCC')).toBe(REDACTED);
    expect(redact('-----BEGIN KEY-----')).toBe(REDACTED);
  });

  it('masks the longer value first when one contains another', () => {
    const redact = createSecretRedactor(['abcd', 'abcdefgh']);
    expect(redact('x abcdefgh y')).toBe(`x ${REDACTED} y`);
  });

  it('ignores values too short to mask safely', () => {
    const redact = createSecretRedactor(['ab', '']);
    expect(redact('ab cd')).toBe('ab cd');
  });
});

describe('isFullyRedactable', () => {
  it('accepts values whose every identifying line can be masked', () => {
    expect(isFullyRedactable('abcd')).toBe(true);
    expect(isFullyRedactable('{\n  "private_key": "abcdef"\n}')).toBe(true);
  });

  it('rejects values with a short alphanumeric part', () => {
    expect(isFullyRedactable('abc')).toBe(false);
    expect(isFullyRedactable('')).toBe(false);
    expect(isFullyRedactable('abcdef\nxy')).toBe(false);
    expect(isFullyRedactable('{\n}')).toBe(false);
  });

  it('rejects short non-ASCII lines that the redactor would not mask', () => {
    expect(isFullyRedactable('long-secret\n密码')).toBe(false);
    expect(isFullyRedactable('long-secret\né')).toBe(false);
    expect(isFullyRedactable('long-secret\n٣٤')).toBe(false);
    expect(isFullyRedactable('long-secret\n€')).toBe(false);
  });

  it('never leaves an accepted value visible after redaction', () => {
    const candidates = [
      'abcd',
      'long-secret\n密码',
      'long-secret\n密码密码',
      '{\n  "k": "abcdef"\n}',
      'line-one\n],\nline-two',
      'long-secret\nxy',
    ];
    for (const value of candidates) {
      if (!isFullyRedactable(value)) continue;
      const redact = createSecretRedactor([value]);
      for (const line of value.split('\n')) {
        const out = redact(line).trim();
        expect(out === REDACTED || /^[!-/:-@[-`{-~]*$/.test(out)).toBe(true);
      }
    }
  });
});
