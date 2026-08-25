// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  prNumberFromUrl,
  parseNativePrUrl,
  openPrDashboardStatusBadge,
  relativePrTime,
  diffSummary,
  prStateBadge,
  summarizeChecks,
  checksBadge,
  summarizeReviews,
  reviewsBadge,
  mergeableBadge,
  reviewDecisionListBadge,
  mergePipelineListBadge,
  prListRowSuggestsResolvableWork,
  prListRowResolveDisabledHeuristic,
  buildPrActivityTimeline,
} from './prFormatting';
describe('prNumberFromUrl', () => {
  it('extracts number from a standard PR URL', () => {
    expect(prNumberFromUrl('https://github.com/owner/repo/pull/123')).toBe('123');
  });
  it('extracts number from an Agent Hub native pulls URL', () => {
    expect(prNumberFromUrl('https://hub.example.com/projects/p1/pulls/55')).toBe('55');
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
describe('parseNativePrUrl', () => {
  it('parses relative native PR URLs', () => {
    expect(parseNativePrUrl('/projects/proj-1/pulls/12')).toEqual({
      projectId: 'proj-1',
      number: 12,
    });
  });
  it('parses absolute native PR URLs', () => {
    expect(parseNativePrUrl('https://hub.example.com/projects/proj-2/pulls/3')).toEqual({
      projectId: 'proj-2',
      number: 3,
    });
  });
  it('returns null for GitHub URLs', () => {
    expect(parseNativePrUrl('https://github.com/o/r/pull/1')).toBeNull();
  });
});
describe('openPrDashboardStatusBadge', () => {
  it('shows conflicts when mergeable is false', () => {
    expect(openPrDashboardStatusBadge({ mergeable: false })?.label).toBe('Conflicts');
  });
  it('shows requested changes from review status', () => {
    expect(openPrDashboardStatusBadge({ reviewStatus: 'changes_requested' })?.label).toBe(
      'Requested changes',
    );
  });
  it('shows awaiting review as fallback', () => {
    expect(openPrDashboardStatusBadge({ reviewStatus: 'awaiting_review' })?.label).toBe(
      'Awaiting review',
    );
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
  it('returns open', () => {
    expect(prStateBadge({ state: 'open' }).label).toBe('open');
  });
  it('returns closed', () => {
    expect(prStateBadge({ state: 'closed' }).label).toBe('closed');
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
  // Guards the mobile side of the CLI `mergeable` tri-state fix:
  // null (= UNKNOWN upstream) must NOT render a misleading "Conflicts" badge.
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
describe('reviewDecisionListBadge', () => {
  it('maps GitHub reviewDecision strings', () => {
    expect(reviewDecisionListBadge('APPROVED')?.label).toBe('Approved');
    expect(reviewDecisionListBadge('REVIEW_REQUIRED')?.label).toBe('Pending review');
  });
  it('returns null when absent', () => {
    expect(reviewDecisionListBadge(null)).toBeNull();
  });
});
describe('mergePipelineListBadge', () => {
  it('returns Blocked', () => {
    expect(mergePipelineListBadge({ mergeable: true, merge_state_status: 'BLOCKED' })?.label).toBe(
      'Blocked',
    );
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
describe('prListRow resolve heuristics', () => {
  it('suggests work when checks fail', () => {
    expect(
      prListRowSuggestsResolvableWork({
        state: 'open',
        mergeable: true,
        mergeable_state: 'clean',
        check_rollup: [{ status: 'completed', conclusion: 'failure' }],
      }),
    ).toBe(true);
  });
  it('disables list resolve when mergeable clean and no signals', () => {
    expect(
      prListRowResolveDisabledHeuristic({
        state: 'open',
        mergeable: true,
        mergeable_state: 'clean',
        check_rollup: [],
      }),
    ).toBe(true);
  });
});
describe('buildPrActivityTimeline', () => {
  it('orders events oldest-first with kind tie-breaker at same timestamp', () => {
    const t0 = '2026-05-01T10:00:00Z';
    const t1 = '2026-05-01T11:00:00Z';
    const pr = { created_at: t0, user: 'bob', merged_at: t1 };
    const detail = {
      reviews: [{ id: 10, user: 'r1', state: 'APPROVED', body: 'ok', submitted_at: t0 }],
      comments: [{ id: 20, user: 'c1', body: 'hi', created_at: t0 }],
      checks: [
        { id: 30, name: 'CI', status: 'completed', conclusion: 'success', completed_at: t0 },
      ],
    };
    const out = buildPrActivityTimeline(pr, detail);
    expect(out.map((x: any) => x.kind)).toEqual(['opened', 'comment', 'review', 'merged']);
  });

  it('excludes CI check runs from the activity timeline', () => {
    const t0 = '2026-05-01T10:00:00Z';
    const pr = { created_at: t0, user: 'bob' };
    const detail = {
      reviews: [],
      comments: [],
      checks: [
        { id: 30, name: 'CI', status: 'completed', conclusion: 'success', completed_at: t0 },
      ],
    };
    const out = buildPrActivityTimeline(pr, detail);
    expect(out.some((x: any) => x.kind === 'check')).toBe(false);
    expect(out.map((x: any) => x.kind)).toEqual(['opened']);
  });
});
