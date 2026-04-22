import { describe, it, expect } from 'vitest';
import { inferPrUrlFromSessionTitle } from './session-title-pr.js';

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
