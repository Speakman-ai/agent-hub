import { describe, it, expect } from 'vitest';
import { shouldReviewPrAuthor, normalizeAuthorAllowlist } from './webhooks.js';
import type { WebhookConfigRow } from '../types.js';

// These tests pin the author-allowlist gate that prevents two Agent Hub
// instances on the same repo from cross-reviewing each other's PRs.
// If this behavior breaks, both instances will wake up to review every PR
// again — exactly the incident this was built to fix.

function cfg(allowlist: string): Pick<WebhookConfigRow, 'author_allowlist'> {
  return { author_allowlist: allowlist };
}

describe('shouldReviewPrAuthor', () => {
  it('returns true when allowlist is an empty array (review-all default)', () => {
    expect(shouldReviewPrAuthor(cfg('[]'), 'anyone')).toBe(true);
  });

  it('returns true when allowlist column is blank (treated as empty)', () => {
    expect(shouldReviewPrAuthor(cfg(''), 'anyone')).toBe(true);
  });

  it('returns true when author matches exactly', () => {
    expect(shouldReviewPrAuthor(cfg('["mcsteen"]'), 'mcsteen')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(shouldReviewPrAuthor(cfg('["MCSteen"]'), 'mcsteen')).toBe(true);
    expect(shouldReviewPrAuthor(cfg('["mcsteen"]'), 'MCSTEEN')).toBe(true);
  });

  it('trims allowlist entries before comparing', () => {
    expect(shouldReviewPrAuthor(cfg('["  mcsteen  "]'), 'mcsteen')).toBe(true);
  });

  it('returns false when author is not in a non-empty allowlist', () => {
    expect(shouldReviewPrAuthor(cfg('["mcsteen"]'), 'otheruser')).toBe(false);
  });

  it('returns false when author is undefined and allowlist is non-empty', () => {
    expect(shouldReviewPrAuthor(cfg('["mcsteen"]'), undefined)).toBe(false);
  });

  it('returns true when author is undefined and allowlist is empty (review-all)', () => {
    expect(shouldReviewPrAuthor(cfg('[]'), undefined)).toBe(true);
  });

  it('fail-open on malformed JSON — treats as empty allowlist', () => {
    // Safer to review an extra PR than silently drop a real one.
    expect(shouldReviewPrAuthor(cfg('{not json'), 'anyone')).toBe(true);
  });

  it('fail-open when stored value is not an array', () => {
    expect(shouldReviewPrAuthor(cfg('"mcsteen"'), 'mcsteen')).toBe(true);
    expect(shouldReviewPrAuthor(cfg('{"foo":1}'), 'mcsteen')).toBe(true);
  });

  it('supports multiple entries in the allowlist', () => {
    const c = cfg('["alice","bob","mcsteen"]');
    expect(shouldReviewPrAuthor(c, 'alice')).toBe(true);
    expect(shouldReviewPrAuthor(c, 'bob')).toBe(true);
    expect(shouldReviewPrAuthor(c, 'mcsteen')).toBe(true);
    expect(shouldReviewPrAuthor(c, 'eve')).toBe(false);
  });

  it('ignores non-string entries in the allowlist', () => {
    // Defensive — if the column got corrupted with mixed types, don't crash.
    const c = cfg('["mcsteen", 42, null]');
    expect(shouldReviewPrAuthor(c, 'mcsteen')).toBe(true);
    expect(shouldReviewPrAuthor(c, '42')).toBe(false);
  });
});

describe('normalizeAuthorAllowlist', () => {
  it('treats undefined as empty array (review-all)', () => {
    expect(normalizeAuthorAllowlist(undefined)).toEqual([]);
  });

  it('treats null as empty array', () => {
    expect(normalizeAuthorAllowlist(null)).toEqual([]);
  });

  it('returns the array unchanged when all entries are non-empty strings', () => {
    expect(normalizeAuthorAllowlist(['mcsteen', 'alice'])).toEqual(['mcsteen', 'alice']);
  });

  it('trims each entry', () => {
    expect(normalizeAuthorAllowlist(['  mcsteen  ', ' alice'])).toEqual(['mcsteen', 'alice']);
  });

  it('drops empty / whitespace-only entries', () => {
    expect(normalizeAuthorAllowlist(['mcsteen', '', '  ', 'alice'])).toEqual(['mcsteen', 'alice']);
  });

  it('returns null for non-array input', () => {
    expect(normalizeAuthorAllowlist('mcsteen')).toBeNull();
    expect(normalizeAuthorAllowlist(42)).toBeNull();
    expect(normalizeAuthorAllowlist({ login: 'mcsteen' })).toBeNull();
  });

  it('returns null when any entry is not a string', () => {
    expect(normalizeAuthorAllowlist(['mcsteen', 42])).toBeNull();
    expect(normalizeAuthorAllowlist([null])).toBeNull();
  });

  it('accepts an empty array', () => {
    expect(normalizeAuthorAllowlist([])).toEqual([]);
  });
});
