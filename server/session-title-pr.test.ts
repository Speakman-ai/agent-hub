import { describe, it, expect } from 'vitest';
import {
  inferPrUrlFromSessionTitle,
  isResolvePrSessionTitle,
  resolveSessionPrUrl,
} from './session-title-pr.js';

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

describe('resolveSessionPrUrl', () => {
  it('prefers the linked card pr_url over the title', () => {
    expect(
      resolveSessionPrUrl({
        sessionName: 'https://github.com/o/r/pull/2 ignored title',
        githubRepo: 'o/r',
        cardPrUrl: 'https://github.com/o/r/pull/1',
      }),
    ).toBe('https://github.com/o/r/pull/1');
  });

  it('falls back to title inference when no card pr_url', () => {
    expect(
      resolveSessionPrUrl({
        sessionName: 'https://github.com/Speakman-ai/agent-hub/pull/1189 Fix the test',
        githubRepo: 'Speakman-ai/agent-hub',
        cardPrUrl: null,
      }),
    ).toBe('https://github.com/Speakman-ai/agent-hub/pull/1189');
  });

  it('treats blank card pr_url as absent', () => {
    expect(
      resolveSessionPrUrl({
        sessionName: '[Resolve PR #7] x',
        githubRepo: 'a/b',
        cardPrUrl: '   ',
      }),
    ).toBe('https://github.com/a/b/pull/7');
  });

  it('returns null when neither card nor title yields a PR', () => {
    expect(
      resolveSessionPrUrl({ sessionName: 'Fix bug', githubRepo: 'a/b', cardPrUrl: null }),
    ).toBeNull();
  });
});

describe('isResolvePrSessionTitle', () => {
  it('returns false for null / undefined / non-string names', () => {
    expect(isResolvePrSessionTitle(null)).toBe(false);
    expect(isResolvePrSessionTitle(undefined)).toBe(false);
    expect(isResolvePrSessionTitle('')).toBe(false);
    expect(isResolvePrSessionTitle('   ')).toBe(false);
  });

  it('recognises [Resolve PR #N] at the start of the title', () => {
    expect(isResolvePrSessionTitle('[Resolve PR #42] Fix thing')).toBe(true);
    expect(isResolvePrSessionTitle('[resolve pr #3] x')).toBe(true);
  });

  it('tolerates leading whitespace (matches after trim)', () => {
    expect(isResolvePrSessionTitle('   [Resolve PR #7] anything')).toBe(true);
  });

  it('does NOT match Review:, ad-hoc titles, or mid-string markers', () => {
    expect(isResolvePrSessionTitle('Review: PR #42 thing')).toBe(false);
    expect(isResolvePrSessionTitle('Fix bug in module')).toBe(false);
    expect(isResolvePrSessionTitle('prefix [Resolve PR #1] x')).toBe(false);
  });

  it('requires a numeric PR id after #', () => {
    expect(isResolvePrSessionTitle('[Resolve PR #] missing number')).toBe(false);
    expect(isResolvePrSessionTitle('[Resolve PR #abc] not numeric')).toBe(false);
  });
});
