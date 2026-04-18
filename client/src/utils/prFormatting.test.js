import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  prNumberFromUrl,
  relativePrTime,
  diffSummary,
  prStateBadge,
  summarizeChecks,
  checksBadge,
  summarizeReviews,
  reviewsBadge,
  mergeableBadge,
  checkRowStyle,
  reviewStateColor,
} from './prFormatting.js';

describe('prNumberFromUrl', () => {
  it('extracts number from a standard PR URL', () => {
    expect(prNumberFromUrl('https://github.com/owner/repo/pull/123')).toBe('123');
  });

  it('extracts number with trailing slash', () => {
    expect(prNumberFromUrl('https://github.com/owner/repo/pull/42/files')).toBe('42');
  });

  it('returns null for invalid input', () => {
    expect(prNumberFromUrl('')).toBeNull();
    expect(prNumberFromUrl(null)).toBeNull();
    expect(prNumberFromUrl(undefined)).toBeNull();
    expect(prNumberFromUrl('https://example.com/no-pr')).toBeNull();
  });
});

describe('relativePrTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('formats seconds', () => {
    expect(relativePrTime('2026-04-18T11:59:30Z')).toBe('30s ago');
  });

  it('formats minutes', () => {
    expect(relativePrTime('2026-04-18T11:55:00Z')).toBe('5m ago');
  });

  it('formats hours', () => {
    expect(relativePrTime('2026-04-18T09:00:00Z')).toBe('3h ago');
  });

  it('formats days', () => {
    expect(relativePrTime('2026-04-15T12:00:00Z')).toBe('3d ago');
  });

  it('returns empty on invalid input', () => {
    expect(relativePrTime(null)).toBe('');
    expect(relativePrTime('not a date')).toBe('');
  });
});

describe('diffSummary', () => {
  it('formats additions, deletions, files', () => {
    expect(diffSummary({ additions: 10, deletions: 2, changed_files: 4 })).toBe(
      '+10 · -2 · 4 files',
    );
  });

  it('pluralizes correctly', () => {
    expect(diffSummary({ additions: 1, deletions: 0, changed_files: 1 })).toBe('+1 · -0 · 1 file');
  });

  it('omits missing fields', () => {
    expect(diffSummary({ additions: 5 })).toBe('+5');
  });

  it('returns empty for null', () => {
    expect(diffSummary(null)).toBe('');
  });
});

describe('prStateBadge', () => {
  it('returns merged for merged_at present', () => {
    expect(prStateBadge({ state: 'closed', merged_at: '2026-04-17T00:00:00Z' }).label).toBe(
      'merged',
    );
  });

  it('returns draft for draft PRs', () => {
    expect(prStateBadge({ state: 'open', draft: true }).label).toBe('draft');
  });

  it('returns open with emerald text class', () => {
    const b = prStateBadge({ state: 'open' });
    expect(b.label).toBe('open');
    expect(b.color).toContain('emerald');
  });

  it('returns closed with red text class', () => {
    const b = prStateBadge({ state: 'closed' });
    expect(b.label).toBe('closed');
    expect(b.color).toContain('red');
  });

  it('handles null', () => {
    expect(prStateBadge(null).label).toBe('unknown');
  });
});

describe('summarizeChecks', () => {
  it('all success', () => {
    const s = summarizeChecks([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'success' },
    ]);
    expect(s).toEqual({
      total: 2,
      success: 2,
      failure: 0,
      pending: 0,
      neutral: 0,
      overall: 'success',
    });
  });

  it('any failure dominates', () => {
    const s = summarizeChecks([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'in_progress' },
    ]);
    expect(s.overall).toBe('failure');
    expect(s.failure).toBe(1);
  });

  it('pending when no failures but something running', () => {
    const s = summarizeChecks([
      { status: 'completed', conclusion: 'success' },
      { status: 'in_progress' },
    ]);
    expect(s.overall).toBe('pending');
    expect(s.pending).toBe(1);
  });

  it('none when empty', () => {
    expect(summarizeChecks([]).overall).toBe('none');
    expect(summarizeChecks(null).overall).toBe('none');
  });

  it('skipped counts as success', () => {
    const s = summarizeChecks([{ status: 'completed', conclusion: 'skipped' }]);
    expect(s.overall).toBe('success');
  });
});

describe('checksBadge', () => {
  it('returns passed count', () => {
    const b = checksBadge({
      total: 3,
      success: 3,
      failure: 0,
      pending: 0,
      neutral: 0,
      overall: 'success',
    });
    expect(b.label).toBe('3/3 passed');
  });

  it('returns failing count', () => {
    const b = checksBadge({
      total: 3,
      success: 1,
      failure: 2,
      pending: 0,
      neutral: 0,
      overall: 'failure',
    });
    expect(b.label).toBe('2/3 failing');
  });

  it('returns running count', () => {
    const b = checksBadge({
      total: 3,
      success: 1,
      failure: 0,
      pending: 2,
      neutral: 0,
      overall: 'pending',
    });
    expect(b.label).toBe('2/3 running');
  });

  it('handles no checks', () => {
    expect(checksBadge({ overall: 'none' }).label).toBe('No checks');
    expect(checksBadge(null).label).toBe('No checks');
  });
});

describe('summarizeReviews', () => {
  it('approved', () => {
    expect(
      summarizeReviews([
        { user: 'alice', state: 'APPROVED', submitted_at: '2026-04-18T00:00:00Z' },
      ]),
    ).toBe('approved');
  });

  it('changes_requested dominates approved', () => {
    expect(
      summarizeReviews([
        { user: 'alice', state: 'APPROVED', submitted_at: '2026-04-18T00:00:00Z' },
        { user: 'bob', state: 'CHANGES_REQUESTED', submitted_at: '2026-04-18T01:00:00Z' },
      ]),
    ).toBe('changes_requested');
  });

  it('later review by same user replaces earlier', () => {
    expect(
      summarizeReviews([
        { user: 'alice', state: 'CHANGES_REQUESTED', submitted_at: '2026-04-18T00:00:00Z' },
        { user: 'alice', state: 'APPROVED', submitted_at: '2026-04-18T02:00:00Z' },
      ]),
    ).toBe('approved');
  });

  it('later COMMENTED does NOT supersede earlier APPROVED', () => {
    expect(
      summarizeReviews([
        { user: 'alice', state: 'APPROVED', submitted_at: '2026-04-18T00:00:00Z' },
        { user: 'alice', state: 'COMMENTED', submitted_at: '2026-04-18T02:00:00Z' },
      ]),
    ).toBe('approved');
  });

  it('commented when only comments', () => {
    expect(summarizeReviews([{ user: 'alice', state: 'COMMENTED' }])).toBe('commented');
  });

  it('none when empty', () => {
    expect(summarizeReviews([])).toBe('none');
    expect(summarizeReviews(null)).toBe('none');
  });
});

describe('mergeableBadge', () => {
  // Guards the CLI `mergeable` tri-state fix: null (= UNKNOWN upstream) must
  // NOT render a misleading "Conflicts" badge.
  it('shows Mergeable for true', () => {
    expect(mergeableBadge(true)).toEqual({ show: true, label: 'Mergeable', good: true });
  });

  it('shows Conflicts for false', () => {
    expect(mergeableBadge(false)).toEqual({ show: true, label: 'Conflicts', good: false });
  });

  it('hides badge for null (UNKNOWN — GitHub still computing)', () => {
    expect(mergeableBadge(null)).toEqual({ show: false });
  });

  it('hides badge for undefined/missing', () => {
    expect(mergeableBadge(undefined)).toEqual({ show: false });
  });

  it('hides badge for non-boolean values', () => {
    expect(mergeableBadge('MERGEABLE')).toEqual({ show: false });
    expect(mergeableBadge(0)).toEqual({ show: false });
    expect(mergeableBadge(1)).toEqual({ show: false });
  });
});

describe('reviewsBadge', () => {
  it('approved', () => {
    expect(reviewsBadge('approved').label).toBe('Approved');
  });

  it('changes_requested', () => {
    expect(reviewsBadge('changes_requested').label).toBe('Changes requested');
  });

  it('default', () => {
    expect(reviewsBadge('none').label).toBe('No reviews');
    expect(reviewsBadge(undefined).label).toBe('No reviews');
  });
});

describe('checkRowStyle', () => {
  it('success conclusion returns success iconKey + emerald color', () => {
    const s = checkRowStyle({ status: 'completed', conclusion: 'success' });
    expect(s.iconKey).toBe('success');
    expect(s.color).toContain('emerald');
  });

  it('failure conclusion returns failure iconKey + red color', () => {
    const s = checkRowStyle({ status: 'completed', conclusion: 'failure' });
    expect(s.iconKey).toBe('failure');
    expect(s.color).toContain('red');
  });

  it('in_progress status returns pending iconKey + yellow color', () => {
    const s = checkRowStyle({ status: 'in_progress' });
    expect(s.iconKey).toBe('pending');
    expect(s.color).toContain('yellow');
  });

  it('unknown state falls back to unknown iconKey', () => {
    const s = checkRowStyle({});
    expect(s.iconKey).toBe('unknown');
  });

  it('skipped conclusion treated as success', () => {
    const s = checkRowStyle({ status: 'completed', conclusion: 'skipped' });
    expect(s.iconKey).toBe('success');
  });

  it('timed_out counts as failure', () => {
    const s = checkRowStyle({ status: 'completed', conclusion: 'timed_out' });
    expect(s.iconKey).toBe('failure');
  });

  it('handles null input gracefully', () => {
    const s = checkRowStyle(null);
    expect(s.iconKey).toBe('unknown');
  });
});

describe('reviewStateColor', () => {
  it('APPROVED → emerald', () => {
    expect(reviewStateColor('APPROVED')).toContain('emerald');
  });

  it('CHANGES_REQUESTED → red', () => {
    expect(reviewStateColor('CHANGES_REQUESTED')).toContain('red');
  });

  it('COMMENTED → blue', () => {
    expect(reviewStateColor('COMMENTED')).toContain('blue');
  });

  it('lowercase input still matched', () => {
    expect(reviewStateColor('approved')).toContain('emerald');
  });

  it('null/unknown → gray', () => {
    expect(reviewStateColor(null)).toContain('gray');
    expect(reviewStateColor('PENDING')).toContain('gray');
  });
});
