import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  prNumberFromUrl,
  parseGithubPullFullName,
  shouldFetchProjectPullDetail,
  relativePrTime,
  diffSummary,
  prStateBadge,
  linkedPrDisplayStatus,
  openPrDashboardStatusBadge,
  summarizeChecks,
  checksBadge,
  summarizeReviews,
  reviewsBadge,
  mergeableBadge,
  mergeButtonState,
  autoMergeToggleState,
  reviewDecisionListBadge,
  mergePipelineListBadge,
  checkRowStyle,
  reviewStateColor,
  prListRowSuggestsResolvableWork,
  prListRowResolveDisabledHeuristic,
  buildPrActivityTimeline,
  parseNativePrUrl,
  isNativePrUrl,
} from './prFormatting';

describe('prNumberFromUrl', () => {
  it('extracts number from a standard PR URL', () => {
    expect(prNumberFromUrl('https://github.com/owner/repo/pull/123')).toBe('123');
  });

  it('extracts number with trailing slash', () => {
    expect(prNumberFromUrl('https://github.com/owner/repo/pull/42/files')).toBe('42');
  });

  it('extracts number from Agent Hub-native PR URLs (/pulls/N)', () => {
    expect(prNumberFromUrl('/projects/my-proj/pulls/7')).toBe('7');
    expect(prNumberFromUrl('https://hub.example.com/projects/my-proj/pulls/12')).toBe('12');
  });

  it('returns null for invalid input', () => {
    expect(prNumberFromUrl('')).toBeNull();
    expect(prNumberFromUrl(null)).toBeNull();
    expect(prNumberFromUrl(undefined)).toBeNull();
    expect(prNumberFromUrl('https://example.com/no-pr')).toBeNull();
  });
});

describe('parseNativePrUrl / isNativePrUrl', () => {
  it('parses relative and absolute native PR URLs', () => {
    expect(parseNativePrUrl('/projects/my-proj/pulls/7')).toEqual({
      projectId: 'my-proj',
      number: 7,
    });
    expect(parseNativePrUrl('https://hub.example.com/projects/p1/pulls/3')).toEqual({
      projectId: 'p1',
      number: 3,
    });
    expect(parseNativePrUrl('/projects/p1/pulls/3?tab=files#diff')).toEqual({
      projectId: 'p1',
      number: 3,
    });
  });

  it('rejects GitHub URLs and garbage', () => {
    expect(parseNativePrUrl('https://github.com/owner/repo/pull/5')).toBeNull();
    expect(parseNativePrUrl('/projects/p1/pulls/abc')).toBeNull();
    expect(parseNativePrUrl(null)).toBeNull();
    expect(parseNativePrUrl('')).toBeNull();
    expect(isNativePrUrl('/projects/p1/pulls/1')).toBe(true);
    expect(isNativePrUrl('https://github.com/o/r/pull/1')).toBe(false);
  });

  it('native URLs still allow the project-scoped detail fetch', () => {
    expect(shouldFetchProjectPullDetail('/projects/p1/pulls/1', 'owner/repo')).toBe(true);
  });
});

describe('parseGithubPullFullName', () => {
  it('returns normalized owner/repo for github.com pull URLs', () => {
    expect(parseGithubPullFullName('https://github.com/Acme/App/pull/12')).toBe('acme/app');
    expect(parseGithubPullFullName('https://github.com/o/r/pull/3/files')).toBe('o/r');
  });

  it('returns null when not a github.com pull URL', () => {
    expect(parseGithubPullFullName('https://gitlab.com/o/r/-/merge_requests/1')).toBeNull();
    expect(parseGithubPullFullName(null)).toBeNull();
  });
});

describe('shouldFetchProjectPullDetail', () => {
  it('returns false when URL repo differs from project githubRepo', () => {
    expect(
      shouldFetchProjectPullDetail('https://github.com/other/repo/pull/99', 'acme/widgets'),
    ).toBe(false);
  });

  it('returns true when repos match (case-insensitive)', () => {
    expect(
      shouldFetchProjectPullDetail('https://github.com/Acme/Widgets/pull/7', 'acme/widgets'),
    ).toBe(true);
  });

  it('returns true for non-github.com URLs (legacy project-scoped fetch)', () => {
    expect(shouldFetchProjectPullDetail('https://git.example.com/o/r/pull/1', 'o/r')).toBe(true);
  });

  it('returns false for github.com URL when project has no githubRepo', () => {
    expect(shouldFetchProjectPullDetail('https://github.com/o/r/pull/1', null)).toBe(false);
    expect(shouldFetchProjectPullDetail('https://github.com/o/r/pull/1', '')).toBe(false);
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

  it('prefers reverted over merged so the list shows the change is undone', () => {
    expect(
      prStateBadge({ state: 'closed', merged_at: '2026-04-17T00:00:00Z', reverted: true }).label,
    ).toBe('reverted');
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

describe('openPrDashboardStatusBadge', () => {
  it('prioritizes conflicts over review state', () => {
    expect(
      openPrDashboardStatusBadge({
        mergeable: false,
        reviewDecision: 'APPROVED',
        reviewStatus: 'approved',
      }),
    ).toMatchObject({ label: 'Conflicts' });
  });

  it('maps review states to dashboard labels', () => {
    expect(openPrDashboardStatusBadge({ reviewDecision: 'CHANGES_REQUESTED' })).toMatchObject({
      label: 'Requested changes',
    });
    expect(openPrDashboardStatusBadge({ reviewDecision: 'APPROVED' })).toMatchObject({
      label: 'Approved',
    });
    expect(openPrDashboardStatusBadge({ reviewDecision: 'REVIEW_REQUIRED' })).toMatchObject({
      label: 'Awaiting review',
    });
    expect(openPrDashboardStatusBadge({ reviewStatus: 'awaiting_review' })).toMatchObject({
      label: 'Awaiting review',
    });
  });
});

describe('linkedPrDisplayStatus', () => {
  it('returns Merged when merged_at is set', () => {
    expect(
      linkedPrDisplayStatus({ pr: { merged_at: '2026-05-01T00:00:00Z', state: 'closed' } }),
    ).toMatchObject({ key: 'merged', label: 'Merged' });
  });

  it('returns Has conflicts when mergeable is false', () => {
    expect(linkedPrDisplayStatus({ pr: { state: 'open', mergeable: false } })).toMatchObject({
      key: 'conflicts',
      label: 'Has conflicts',
    });
  });

  it('returns Closed for closed unmerged PRs', () => {
    expect(linkedPrDisplayStatus({ pr: { state: 'closed', merged_at: null } })).toMatchObject({
      key: 'closed',
      label: 'Closed',
    });
  });

  it('returns Pending revisions from card review_status', () => {
    expect(
      linkedPrDisplayStatus({
        pr: { state: 'open' },
        linkedCardReviewStatus: 'changes_requested',
      }),
    ).toMatchObject({ key: 'pending_revisions', label: 'Pending revisions' });
  });

  it('returns Pending review from REVIEW_REQUIRED', () => {
    expect(
      linkedPrDisplayStatus({
        pr: { state: 'open', review_decision: 'REVIEW_REQUIRED' },
      }),
    ).toMatchObject({ key: 'pending_review', label: 'Pending review' });
  });

  it('returns Pending review for awaiting_review on the card', () => {
    expect(
      linkedPrDisplayStatus({
        pr: { state: 'open' },
        linkedCardReviewStatus: 'awaiting_review',
      }),
    ).toMatchObject({ key: 'pending_review', label: 'Pending review' });
  });
});

describe('summarizeChecks', () => {
  it('all success', () => {
    const s = summarizeChecks([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'success' },
    ]);
    expect(s!).toEqual({
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

describe('reviewDecisionListBadge', () => {
  it('maps GitHub reviewDecision strings', () => {
    expect(reviewDecisionListBadge('APPROVED')?.label).toBe('Approved');
    expect(reviewDecisionListBadge('CHANGES_REQUESTED')?.label).toBe('Changes requested');
    expect(reviewDecisionListBadge('REVIEW_REQUIRED')?.label).toBe('Pending review');
  });

  it('returns null when absent', () => {
    expect(reviewDecisionListBadge(null)).toBeNull();
    expect(reviewDecisionListBadge('')).toBeNull();
  });
});

describe('mergePipelineListBadge', () => {
  it('returns Blocked for merge_state_status', () => {
    const b = mergePipelineListBadge({ mergeable: true, merge_state_status: 'BLOCKED' });
    expect(b?.label).toBe('Blocked');
  });

  it('returns null when mergeable is false (conflicts badge owns that)', () => {
    expect(mergePipelineListBadge({ mergeable: false, merge_state_status: 'DIRTY' })).toBeNull();
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

describe('prListRow resolve heuristics', () => {
  it('suggests work when merge conflicts', () => {
    expect(
      prListRowSuggestsResolvableWork({
        state: 'open',
        mergeable: false,
        mergeable_state: 'dirty',
      }),
    ).toBe(true);
  });

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

  it('does not disable when mergeability is still unknown', () => {
    expect(
      prListRowResolveDisabledHeuristic({
        state: 'open',
        mergeable: null,
        mergeable_state: 'unknown',
      }),
    ).toBe(false);
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

describe('mergeButtonState', () => {
  it('open + mergeable=true → enabled', () => {
    const s = mergeButtonState({ state: 'open', mergeable: true });
    expect(s.enabled).toBe(true);
    expect(typeof s.reason).toBe('string');
    expect(s.reason.length).toBeGreaterThan(0);
  });

  it('mergeable=false (conflicts) → disabled with conflict reason', () => {
    const s = mergeButtonState({ state: 'open', mergeable: false });
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/conflict/i);
  });

  it('mergeable=null (still computing) → disabled with computing reason', () => {
    const s = mergeButtonState({ state: 'open', mergeable: null });
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/computing|refresh/i);
  });

  it('clean merge state enables a list row when mergeable is null', () => {
    const s = mergeButtonState({ state: 'open', mergeable: null, merge_state_status: 'CLEAN' });
    expect(s.enabled).toBe(true);
    expect(s.reason).toMatch(/squash and merge/i);
  });

  it('branch-protection and unstable states stay disabled', () => {
    expect(
      mergeButtonState({ state: 'open', mergeable: true, merge_state_status: 'BLOCKED' }),
    ).toMatchObject({ enabled: false });
    expect(
      mergeButtonState({ state: 'open', mergeable: true, merge_state_status: 'UNSTABLE' }),
    ).toMatchObject({ enabled: false });
  });

  it('explicit conflicts win over a clean status', () => {
    expect(
      mergeButtonState({ state: 'open', mergeable: false, merge_state_status: 'CLEAN' }),
    ).toMatchObject({ enabled: false, reason: expect.stringMatching(/conflict/i) });
  });

  it('mergeable undefined → disabled', () => {
    const s = mergeButtonState({ state: 'open' });
    expect(s.enabled).toBe(false);
  });

  it('already merged → disabled even if mergeable=true', () => {
    const s = mergeButtonState({
      state: 'closed',
      merged_at: '2026-04-29T00:00:00Z',
      mergeable: true,
    });
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/merged/i);
  });

  it('draft PR → disabled even if mergeable=true', () => {
    const s = mergeButtonState({ state: 'open', draft: true, mergeable: true });
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/draft/i);
  });

  it('closed PR → disabled', () => {
    const s = mergeButtonState({ state: 'closed', mergeable: true });
    expect(s.enabled).toBe(false);
  });

  it('null PR → disabled', () => {
    expect(mergeButtonState(null).enabled).toBe(false);
    expect(mergeButtonState(undefined).enabled).toBe(false);
  });
});

describe('autoMergeToggleState', () => {
  const ghUrl = 'https://github.com/acme/webapp/pull/42';

  it('is available and off for an open GitHub PR with no auto_merge', () => {
    const s = autoMergeToggleState({ state: 'open', html_url: ghUrl, auto_merge: null });
    expect(s.available).toBe(true);
    expect(s.enabled).toBe(false);
    expect(s.method).toBeNull();
  });

  it('reflects armed auto-merge from the auto_merge object', () => {
    const s = autoMergeToggleState({
      state: 'open',
      html_url: ghUrl,
      auto_merge: { merge_method: 'squash', enabled_by: { login: 'me' } },
    });
    expect(s.available).toBe(true);
    expect(s.enabled).toBe(true);
    expect(s.method).toBe('squash');
  });

  it('is unavailable for native (non-github) PR URLs', () => {
    const s = autoMergeToggleState({ state: 'open', html_url: '/projects/demo/pulls/3' });
    expect(s.available).toBe(false);
  });

  it('is unavailable for merged, closed, or draft PRs', () => {
    expect(
      autoMergeToggleState({ state: 'open', html_url: ghUrl, merged_at: '2026-01-01T00:00:00Z' })
        .available,
    ).toBe(false);
    expect(autoMergeToggleState({ state: 'closed', html_url: ghUrl }).available).toBe(false);
    expect(autoMergeToggleState({ state: 'open', html_url: ghUrl, draft: true }).available).toBe(
      false,
    );
  });

  it('null PR → unavailable', () => {
    expect(autoMergeToggleState(null).available).toBe(false);
    expect(autoMergeToggleState(undefined).available).toBe(false);
  });
});

describe('buildPrActivityTimeline', () => {
  it('orders events oldest-first and interleaves kinds by tie-breaker at same ms', () => {
    const t0 = '2026-05-01T10:00:00Z';
    const t1 = '2026-05-01T11:00:00Z';
    const pr = {
      created_at: t0,
      user: 'bob',
      merged_at: t1,
    };
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

  it('interleaves commits chronologically and sorts them before same-ms comments/reviews', () => {
    const t0 = '2026-05-01T10:00:00Z';
    const t1 = '2026-05-01T11:00:00Z';
    const t2 = '2026-05-01T12:00:00Z';
    const pr = { created_at: t0, user: 'bob', merged_at: t2 };
    const detail = {
      commits: [
        { sha: 'aaa111', subject: 'feat: one', author: 'ryan', date: t1 },
        { sha: 'bbb222', subject: 'fix: two', author: 'ryan', date: t0 },
      ],
      comments: [{ id: 20, user: 'c1', body: 'hi', created_at: t1 }],
      reviews: [{ id: 10, user: 'r1', state: 'APPROVED', submitted_at: t2 }],
    };
    const out = buildPrActivityTimeline(pr, detail);
    // t0: opened(bob) then commit bbb222. t1: commit aaa111 then comment. t2: review then merged.
    expect(out.map((x: any) => x.kind)).toEqual([
      'opened',
      'commit',
      'commit',
      'comment',
      'review',
      'merged',
    ]);
    const commitItem = out.find((x: any) => x.kind === 'commit' && x.commit.sha === 'aaa111');
    expect(commitItem.id).toBe('commit-aaa111');
    expect(commitItem.commit.subject).toBe('feat: one');
  });

  it('skips commits with an unparseable or missing date', () => {
    const pr = { created_at: '2026-05-01T10:00:00Z', user: 'bob' };
    const detail = {
      commits: [
        { sha: 'aaa111', subject: 'no date', author: 'ryan' },
        { sha: 'bbb222', subject: 'bad date', author: 'ryan', date: 'not-a-date' },
      ],
    };
    const out = buildPrActivityTimeline(pr, detail);
    expect(out.some((x: any) => x.kind === 'commit')).toBe(false);
    expect(out.map((x: any) => x.kind)).toEqual(['opened']);
  });

  it('excludes CI check runs from the activity timeline (surfaced in CI Checks instead)', () => {
    const t0 = '2026-05-01T10:00:00Z';
    const pr = { created_at: t0, user: 'bob' };
    const detail = {
      reviews: [],
      comments: [],
      checks: [
        { id: 30, name: 'CI', status: 'completed', conclusion: 'success', completed_at: t0 },
        { id: 31, name: 'lint', status: 'in_progress', started_at: t0 },
      ],
    };
    const out = buildPrActivityTimeline(pr, detail);
    expect(out.some((x: any) => x.kind === 'check')).toBe(false);
    expect(out.map((x: any) => x.kind)).toEqual(['opened']);
  });

  it('emits closed without merging when merged_at is absent', () => {
    const pr = {
      created_at: '2026-05-01T09:00:00Z',
      closed_at: '2026-05-02T09:00:00Z',
      user: 'u',
    };
    const out = buildPrActivityTimeline(pr, { reviews: [], comments: [], checks: [] });
    expect(out.map((x: any) => x.kind)).toEqual(['opened', 'closed']);
  });

  it('skips merged and closed lifecycle rows when timestamps are missing', () => {
    const pr = { created_at: '2026-05-01T09:00:00Z', merged_at: 'not-a-date' };
    const out = buildPrActivityTimeline(pr, {});
    expect(out.every((x: any) => x.kind === 'opened')).toBe(true);
  });
});
