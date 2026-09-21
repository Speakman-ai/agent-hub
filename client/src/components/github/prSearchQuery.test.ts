import { describe, it, expect } from 'vitest';
import { parsePrSearchQuery, prIsMerged, prMatchesMerged, prMatchesTerms } from './prSearchQuery';

describe('parsePrSearchQuery', () => {
  it('reads the state the qualifiers ask for', () => {
    expect(parsePrSearchQuery('is:pr is:open')).toEqual({
      state: 'open',
      merged: null,
      terms: '',
    });
    expect(parsePrSearchQuery('is:pr is:closed')).toEqual({
      state: 'closed',
      merged: null,
      terms: '',
    });
    expect(parsePrSearchQuery('is:open is:closed')).toEqual({
      state: 'all',
      merged: null,
      terms: '',
    });
  });

  it('leaves state null when the query names none, so the tab still decides', () => {
    expect(parsePrSearchQuery('is:pr')).toEqual({ state: null, merged: null, terms: '' });
    expect(parsePrSearchQuery('flaky')).toEqual({ state: null, merged: null, terms: 'flaky' });
    expect(parsePrSearchQuery('')).toEqual({ state: null, merged: null, terms: '' });
  });

  it('keeps the free text and normalises whitespace/case', () => {
    expect(parsePrSearchQuery('is:pr is:closed   Flaky   Test ')).toEqual({
      state: 'closed',
      merged: null,
      terms: 'flaky test',
    });
  });

  it('does not treat a qualifier-like substring as a qualifier', () => {
    expect(parsePrSearchQuery('refactor:open')).toEqual({
      state: null,
      merged: null,
      terms: 'refactor:open',
    });
  });
});

describe('prMatchesTerms', () => {
  const pr = { title: 'Fix the flaky test', number: 123, user: 'alice', head: 'feature/x' };

  it('matches title, number, author, and head branch', () => {
    expect(prMatchesTerms(pr, 'flaky')).toBe(true);
    expect(prMatchesTerms(pr, '123')).toBe(true);
    expect(prMatchesTerms(pr, 'alice')).toBe(true);
    expect(prMatchesTerms(pr, 'feature/x')).toBe(true);
  });

  it('requires every term to match', () => {
    expect(prMatchesTerms(pr, 'flaky alice')).toBe(true);
    expect(prMatchesTerms(pr, 'flaky bob')).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(prMatchesTerms(pr, '')).toBe(true);
  });
});

describe('parsePrSearchQuery — merge constraint', () => {
  it('is:merged requests closed AND keeps a merged-only constraint', () => {
    // Dropping `merged` here is what made `is:merged` list abandoned PRs too.
    expect(parsePrSearchQuery('is:pr is:merged')).toEqual({
      state: 'closed',
      merged: true,
      terms: '',
    });
  });

  it('is:unmerged constrains merge without forcing a state', () => {
    expect(parsePrSearchQuery('is:pr is:unmerged')).toEqual({
      state: null,
      merged: false,
      terms: '',
    });
  });

  it('keeps free text alongside the merge constraint', () => {
    expect(parsePrSearchQuery('is:merged Flaky')).toEqual({
      state: 'closed',
      merged: true,
      terms: 'flaky',
    });
  });

  it('cancels contradictory merge qualifiers instead of picking one', () => {
    expect(parsePrSearchQuery('is:merged is:unmerged').merged).toBeNull();
  });
});

describe('prMatchesMerged', () => {
  const merged = { number: 1, merged_at: '2026-04-19T10:00:00Z' };
  const mergedFlag = { number: 2, merged: true };
  const abandoned = { number: 3, state: 'closed', merged: false, merged_at: null };

  it('detects merged PRs by either field', () => {
    expect(prIsMerged(merged)).toBe(true);
    expect(prIsMerged(mergedFlag)).toBe(true);
    expect(prIsMerged(abandoned)).toBe(false);
  });

  it('excludes closed-but-unmerged PRs when merged is required', () => {
    expect(prMatchesMerged(merged, true)).toBe(true);
    expect(prMatchesMerged(abandoned, true)).toBe(false);
  });

  it('excludes merged PRs when unmerged is required', () => {
    expect(prMatchesMerged(abandoned, false)).toBe(true);
    expect(prMatchesMerged(merged, false)).toBe(false);
  });

  it('admits everything when unconstrained', () => {
    expect(prMatchesMerged(merged, null)).toBe(true);
    expect(prMatchesMerged(abandoned, null)).toBe(true);
  });
});
