import { describe, it, expect } from 'vitest';
import {
  inferPrUrlFromSessionTitle,
  isResolvePrSessionTitle,
  parseResolvePrNumberFromTitle,
} from '../../../shared/utils/sessionTitlePr.js';

describe('sessionTitlePr (shared)', () => {
  describe('inferPrUrlFromSessionTitle', () => {
    it('parses [Resolve PR #N] with githubRepo', () => {
      expect(inferPrUrlFromSessionTitle('[Resolve PR #42] Fix thing', 'acme/app')).toBe(
        'https://github.com/acme/app/pull/42',
      );
    });

    it('is case-insensitive for Resolve prefix', () => {
      expect(inferPrUrlFromSessionTitle('[resolve pr #3] x', 'a/b')).toBe(
        'https://github.com/a/b/pull/3',
      );
    });

    it('returns null without githubRepo for Resolve-style title', () => {
      expect(inferPrUrlFromSessionTitle('[Resolve PR #1] x', null)).toBeNull();
    });
  });

  describe('parseResolvePrNumberFromTitle', () => {
    it('extracts PR number', () => {
      expect(parseResolvePrNumberFromTitle('[Resolve PR #12] fix')).toBe('12');
      expect(parseResolvePrNumberFromTitle('[resolve pr #3] x')).toBe('3');
      expect(parseResolvePrNumberFromTitle('other')).toBeNull();
    });
  });
});
