import { describe, expect, it } from 'vitest';
import { evaluateBaseDrift } from './base-drift.js';
import {
  decideBaseDriftAction,
  DEFAULT_BASE_DRIFT_HAZARD_PATHS,
  parseBaseDriftPatch,
  resolveBaseDriftPolicy,
} from './base-drift-policy.js';

function stale(basePaths: string[], branchPaths: string[]) {
  const outcome = evaluateBaseDrift({
    validatedBaseSha: 'b1',
    currentBaseSha: 'b2',
    basePaths,
    branchPaths,
  });
  if (outcome.kind !== 'stale') throw new Error(`expected stale, got ${outcome.reason}`);
  return outcome;
}

describe('resolveBaseDriftPolicy', () => {
  it('defaults to full with the default hazard globs', () => {
    expect(resolveBaseDriftPolicy(undefined)).toEqual({
      mode: 'full',
      reuseJobs: [],
      hazardPaths: [...DEFAULT_BASE_DRIFT_HAZARD_PATHS],
    });
  });

  it('reads an unknown mode as full so a bad value never relaxes the gate', () => {
    expect(resolveBaseDriftPolicy({ mode: 'nope' as never }).mode).toBe('full');
  });

  it('honors an explicitly empty hazard list', () => {
    expect(resolveBaseDriftPolicy({ mode: 'fast', hazardPaths: [] }).hazardPaths).toEqual([]);
  });
});

describe('decideBaseDriftAction', () => {
  const sameDir = stale(['app/views/a.py'], ['app/views/b.py']);

  it('full re-runs everything', () => {
    const action = decideBaseDriftAction(sameDir, resolveBaseDriftPolicy({ mode: 'full' }));
    expect(action).toMatchObject({ kind: 'rerun_full', reason: 'policy_full' });
  });

  it('off proceeds without re-validation', () => {
    const action = decideBaseDriftAction(sameDir, resolveBaseDriftPolicy({ mode: 'off' }));
    expect(action.kind).toBe('proceed');
  });

  it('fast reuses the listed jobs on a same-directory overlap', () => {
    const action = decideBaseDriftAction(
      sameDir,
      resolveBaseDriftPolicy({ mode: 'fast', reuseJobs: ['e2e'] }),
    );
    expect(action).toMatchObject({ kind: 'rerun_fast', reuseJobs: ['e2e'] });
  });

  it('fast escalates to full when both sides changed the same file', () => {
    const action = decideBaseDriftAction(
      stale(['app/views/a.py'], ['app/views/a.py']),
      resolveBaseDriftPolicy({ mode: 'fast', reuseJobs: ['e2e'] }),
    );
    expect(action).toMatchObject({ kind: 'rerun_full', reason: 'same_file' });
  });

  it('explains a fast fallback so kept jobs re-running does not look inverted', () => {
    const sameFile = decideBaseDriftAction(
      stale(['app/views/a.py'], ['app/views/a.py']),
      resolveBaseDriftPolicy({ mode: 'fast', reuseJobs: ['e2e'] }),
    );
    expect(sameFile).toMatchObject({
      fastFallbackNote:
        'Fast mode re-ran every job: the base branch and this branch both changed app/views/a.py.',
    });

    const hazard = decideBaseDriftAction(
      stale(['jobs/migrations/0088_foo.py'], ['jobs/migrations/0088_bar.py']),
      resolveBaseDriftPolicy({ mode: 'fast', reuseJobs: ['e2e'] }),
    );
    expect(hazard.kind === 'rerun_full' && hazard.fastFallbackNote).toContain(
      'the overlapping changes touch jobs/migrations/0088_bar.py, jobs/migrations/0088_foo.py',
    );

    const full = decideBaseDriftAction(sameDir, resolveBaseDriftPolicy({ mode: 'full' }));
    expect(full.kind === 'rerun_full' && full.fastFallbackNote).toBeFalsy();
  });

  it('fast escalates to full on the sibling-migration collision', () => {
    const action = decideBaseDriftAction(
      stale(['jobs/migrations/0088_foo.py'], ['jobs/migrations/0088_bar.py']),
      resolveBaseDriftPolicy({ mode: 'fast', reuseJobs: ['e2e'] }),
    );
    expect(action).toMatchObject({ kind: 'rerun_full', reason: 'hazard_path' });
  });

  it('ignores hazard paths that are not on the overlapping ground', () => {
    const action = decideBaseDriftAction(
      stale(['app/views/a.py', 'billing/migrations/0001.py'], ['app/views/b.py']),
      resolveBaseDriftPolicy({ mode: 'fast', reuseJobs: ['e2e'] }),
    );
    expect(action.kind).toBe('rerun_fast');
  });

  it('fast with no reuse jobs behaves like full', () => {
    const action = decideBaseDriftAction(sameDir, resolveBaseDriftPolicy({ mode: 'fast' }));
    expect(action).toMatchObject({ kind: 'rerun_full', reason: 'no_reuse_jobs' });
  });
});

describe('parseBaseDriftPatch', () => {
  it('accepts null as a clear', () => {
    expect(parseBaseDriftPatch(null)).toEqual({ ok: true, value: null });
  });

  it('trims and dedupes lists', () => {
    expect(parseBaseDriftPatch({ mode: 'fast', reuseJobs: [' e2e ', 'e2e', ''] })).toEqual({
      ok: true,
      value: { mode: 'fast', reuseJobs: ['e2e'] },
    });
  });

  it('rejects an unknown mode and non-string lists', () => {
    expect(parseBaseDriftPatch({ mode: 'sometimes' }).ok).toBe(false);
    expect(parseBaseDriftPatch({ reuseJobs: [1] }).ok).toBe(false);
    expect(parseBaseDriftPatch([]).ok).toBe(false);
  });
});
