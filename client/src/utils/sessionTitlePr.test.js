import { describe, it, expect } from 'vitest';
import {
  inferPrUrlFromSessionTitle,
  isResolvePrSessionTitle,
  parseResolvePrNumberFromTitle,
} from '../../../shared/utils/sessionTitlePr.js';

/** Mirrors server/session-title-pr.test.ts so shared JS cannot drift from server semantics. */
describe('inferPrUrlFromSessionTitle', () => {
  it('returns null for empty / non-string names', () => {
    expect(inferPrUrlFromSessionTitle(null, 'o/r')).toBeNull();
    expect(inferPrUrlFromSessionTitle(undefined, 'o/r')).toBeNull();
    expect(inferPrUrlFromSessionTitle('', 'o/r')).toBeNull();
    expect(inferPrUrlFromSessionTitle('   ', 'o/r')).toBeNull();
  });

  it('parses [Resolve PR #N] with project githubRepo', () => {
    expect(inferPrUrlFromSessionTitle('[Resolve PR #42] Fix thing', 'acme/app')).toBe(
      'https://github.com/acme/app/pull/42',
    );
  });

  it('is case-insensitive for Resolve prefix', () => {
    expect(inferPrUrlFromSessionTitle('[resolve pr #3] x', 'a/b')).toBe(
      'https://github.com/a/b/pull/3',
    );
  });

  it('parses Review: PR #N prefix with githubRepo', () => {
    expect(inferPrUrlFromSessionTitle('Review: PR #501 My feature', 'Speakman-ai/agent-hub')).toBe(
      'https://github.com/Speakman-ai/agent-hub/pull/501',
    );
  });

  it('prefers explicit github.com pull URL anywhere in the title', () => {
    expect(
      inferPrUrlFromSessionTitle(
        'Review: PR #1 https://github.com/other/repo/pull/99 trailing',
        'ignored/ignored',
      ),
    ).toBe('https://github.com/other/repo/pull/99');
  });

  it('returns null for Resolve/Review pattern when githubRepo is missing', () => {
    expect(inferPrUrlFromSessionTitle('[Resolve PR #1] x', null)).toBeNull();
    expect(inferPrUrlFromSessionTitle('[Resolve PR #1] x', '')).toBeNull();
    expect(inferPrUrlFromSessionTitle('Review: PR #1 x', undefined)).toBeNull();
  });

  it('returns null for githubRepo without slash', () => {
    expect(inferPrUrlFromSessionTitle('[Resolve PR #1] x', 'badrepo')).toBeNull();
  });

  it('does not match Resolve pattern mid-string', () => {
    expect(inferPrUrlFromSessionTitle('prefix [Resolve PR #1] x', 'a/b')).toBeNull();
  });
});

describe('isResolvePrSessionTitle', () => {
  it('is true only for leading Resolve PR prefix', () => {
    expect(isResolvePrSessionTitle('[Resolve PR #9] z')).toBe(true);
    expect(isResolvePrSessionTitle('[resolve pr #2]')).toBe(true);
    expect(isResolvePrSessionTitle('Review: PR #9 foo')).toBe(false);
    expect(isResolvePrSessionTitle('prefix [Resolve PR #1] x')).toBe(false);
  });

  it('returns false for empty / non-string', () => {
    expect(isResolvePrSessionTitle(null)).toBe(false);
    expect(isResolvePrSessionTitle(undefined)).toBe(false);
    expect(isResolvePrSessionTitle('')).toBe(false);
    expect(isResolvePrSessionTitle('   ')).toBe(false);
  });
});

describe('parseResolvePrNumberFromTitle', () => {
  it('extracts PR number for Resolve prefix only', () => {
    expect(parseResolvePrNumberFromTitle('[Resolve PR #12] fix')).toBe('12');
    expect(parseResolvePrNumberFromTitle('[resolve pr #3] x')).toBe('3');
    expect(parseResolvePrNumberFromTitle('other')).toBeNull();
    expect(parseResolvePrNumberFromTitle('Review: PR #9')).toBeNull();
    expect(parseResolvePrNumberFromTitle('prefix [Resolve PR #1] x')).toBeNull();
  });
});
