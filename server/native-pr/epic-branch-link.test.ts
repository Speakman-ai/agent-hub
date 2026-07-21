import { describe, it, expect } from 'vitest';
import {
  matchEpicForPrBranches,
  prsForEpicFeatureBranch,
  type EpicBranchRef,
} from './epic-branch-link.js';

const epics: EpicBranchRef[] = [
  { id: 'e1', name: 'Reliability', color: '#111', pr_base_branch: 'feature/reliability' },
  { id: 'e2', name: 'Billing', color: '#222', pr_base_branch: 'feature/billing' },
  { id: 'e3', name: 'No branch', color: '#333', pr_base_branch: null },
  { id: 'e4', name: 'Blank branch', color: '#444', pr_base_branch: '   ' },
];

describe('matchEpicForPrBranches', () => {
  it('matches a PR whose base is a feature branch as "targets"', () => {
    const m = matchEpicForPrBranches(epics, {
      head: 'agent-hub/dev/session-abc',
      base: 'feature/reliability',
    });
    expect(m).toMatchObject({
      id: 'e1',
      relation: 'targets',
      feature_branch: 'feature/reliability',
    });
  });

  it('matches a PR whose head is a feature branch as "integration"', () => {
    const m = matchEpicForPrBranches(epics, { head: 'feature/billing', base: 'main' });
    expect(m).toMatchObject({ id: 'e2', relation: 'integration' });
  });

  it('prefers a base (targets) match over a head (integration) match', () => {
    // Contrived: one epic uses the branch as base, another as head.
    const twoEpics: EpicBranchRef[] = [
      { id: 'h', name: 'Head epic', pr_base_branch: 'feature/x' },
      { id: 'b', name: 'Base epic', pr_base_branch: 'feature/y' },
    ];
    const m = matchEpicForPrBranches(twoEpics, { head: 'feature/x', base: 'feature/y' });
    expect(m).toMatchObject({ id: 'b', relation: 'targets' });
  });

  it('returns null when no epic feature branch matches', () => {
    expect(matchEpicForPrBranches(epics, { head: 'wip', base: 'main' })).toBeNull();
  });

  it('ignores epics with null/blank feature branches', () => {
    expect(matchEpicForPrBranches(epics, { head: '   ', base: '' })).toBeNull();
    // A blank branch on an epic must never match a blank PR base.
    expect(matchEpicForPrBranches(epics, { head: null, base: '   ' })).toBeNull();
  });

  it('trims whitespace before comparing', () => {
    const m = matchEpicForPrBranches(epics, { base: '  feature/billing  ' });
    expect(m).toMatchObject({ id: 'e2', relation: 'targets' });
  });

  it('carries the epic color through, defaulting to null', () => {
    const m = matchEpicForPrBranches([{ id: 'z', name: 'Z', pr_base_branch: 'feature/z' }], {
      base: 'feature/z',
    });
    expect(m).toMatchObject({ id: 'z', color: null });
  });
});

describe('prsForEpicFeatureBranch', () => {
  const pulls = [
    { number: 1, base: 'feature/reliability', head: 'session-a' }, // targets
    { number: 2, base: 'main', head: 'feature/reliability' }, // integration
    { number: 3, base: 'main', head: 'session-b' }, // unrelated
    { number: 4, base: 'feature/reliability', head: 'session-c' }, // targets
  ];

  it('returns targets + integration PRs tagged with relation, preserving order', () => {
    const out = prsForEpicFeatureBranch(pulls, 'feature/reliability');
    expect(out.map((p) => [p.number, p.epic_relation])).toEqual([
      [1, 'targets'],
      [2, 'integration'],
      [4, 'targets'],
    ]);
  });

  it('returns [] for a blank or null feature branch', () => {
    expect(prsForEpicFeatureBranch(pulls, null)).toEqual([]);
    expect(prsForEpicFeatureBranch(pulls, '   ')).toEqual([]);
  });

  it('does not mutate the input PR objects', () => {
    const out = prsForEpicFeatureBranch(pulls, 'feature/reliability');
    expect(out[0]).not.toBe(pulls[0]);
    expect((pulls[0] as Record<string, unknown>).epic_relation).toBeUndefined();
  });
});
