import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  BANNED_TOKENS,
  findInternalTokens,
  rollingHash,
  type BannedToken,
} from './internal-tokens.js';

const probe: BannedToken[] = [
  {
    sha256: createHash('sha256').update('acmetracker').digest('hex'),
    length: 'acmetracker'.length,
    rolling: rollingHash('acmetracker'),
    label: 'probe',
  },
];

describe('findInternalTokens', () => {
  it('matches a banned token in any casing or separator', () => {
    for (const text of [
      'acmetracker',
      'AcmeTracker',
      'ACME_TRACKER_ENV',
      'the acme-tracker label',
      'Acme Tracker',
      'https://hub.acmetracker.io/#/chat',
    ]) {
      expect(findInternalTokens(text, probe), text).toEqual(['probe']);
    }
  });

  it('matches the token with a prefix or suffix glued on', () => {
    for (const text of [
      'AcmeTrackerDev',
      'acmetracker-dev agent',
      'ACME_TRACKER_CLIENT',
      'myacmetracker',
      'MyAcme Tracker',
      'x acmetrackers y',
      'the acme-trackerclient build',
      'Acme\n * TrackerDev',
      'one\nAcmeTrackerApp',
    ]) {
      expect(findInternalTokens(text, probe), text).toEqual(['probe']);
    }
  });

  it('finds the token at every offset of a long word', () => {
    for (let pad = 0; pad < 20; pad++) {
      const text = 'x'.repeat(pad) + 'acmetracker' + 'y'.repeat(20 - pad);
      expect(findInternalTokens(text, probe), text).toEqual(['probe']);
    }
  });

  it('does not match near misses or unrelated text', () => {
    expect(findInternalTokens('acme tracking', probe)).toEqual([]);
    expect(findInternalTokens('acme x tracker', probe)).toEqual([]);
    expect(findInternalTokens('', probe)).toEqual([]);
  });

  it('ships a non-empty hash-only ban list', () => {
    expect(BANNED_TOKENS.length).toBeGreaterThan(0);
    for (const t of BANNED_TOKENS) {
      expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(t.rolling) && t.rolling >= 0 && t.rolling < 2 ** 31).toBe(true);
    }
  });
});
