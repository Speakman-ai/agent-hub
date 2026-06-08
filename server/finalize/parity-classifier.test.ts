/**
 * Unit tests for the Finalize↔GitHub parity classifier (pure functions).
 *
 * The classifier is the heart of the parity harness: it decides whether a
 * (Finalize verdict, GitHub verdict) pair is a dangerous false-green, a benign
 * false-red, an agreement, or indeterminate. The whole epic exit bar (~0
 * false_green over 200+ PRs) is computed from this output, so it gets the most
 * exhaustive coverage.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyDivergence,
  finalizeJobsToParityJobs,
  finalizeStatusToVerdict,
  githubChecksToParityJobs,
  githubChecksToVerdict,
  isDangerousDivergence,
  isDivergence,
  isDivergenceClass,
  normalizeFinalizeJobState,
  normalizeGithubCheckState,
  type DivergenceClass,
} from './parity-classifier.js';

describe('classifyDivergence', () => {
  it('classifies the full 3x3 verdict matrix', () => {
    const cases: Array<[ParityIn, ParityIn, DivergenceClass]> = [
      ['green', 'green', 'agree_green'],
      ['green', 'red', 'false_green'],
      ['green', 'unknown', 'indeterminate'],
      ['red', 'green', 'false_red'],
      ['red', 'red', 'agree_red'],
      ['red', 'unknown', 'indeterminate'],
      ['unknown', 'green', 'indeterminate'],
      ['unknown', 'red', 'indeterminate'],
      ['unknown', 'unknown', 'indeterminate'],
    ];
    for (const [fin, gh, expected] of cases) {
      expect(classifyDivergence(fin, gh), `${fin} vs ${gh}`).toBe(expected);
    }
  });

  it('treats the PR#1001 shape (Finalize green / GitHub red) as false_green', () => {
    expect(classifyDivergence('green', 'red')).toBe('false_green');
  });

  it('flags false_green as the only dangerous divergence', () => {
    expect(isDangerousDivergence('false_green')).toBe(true);
    expect(isDangerousDivergence('false_red')).toBe(false);
    expect(isDangerousDivergence('agree_green')).toBe(false);
    expect(isDangerousDivergence('agree_red')).toBe(false);
    expect(isDangerousDivergence('indeterminate')).toBe(false);
  });

  it('counts both false classes as divergences, agreements as not', () => {
    expect(isDivergence('false_green')).toBe(true);
    expect(isDivergence('false_red')).toBe(true);
    expect(isDivergence('agree_green')).toBe(false);
    expect(isDivergence('agree_red')).toBe(false);
    expect(isDivergence('indeterminate')).toBe(false);
  });
});

describe('isDivergenceClass', () => {
  it('accepts known classes and rejects junk', () => {
    expect(isDivergenceClass('false_green')).toBe(true);
    expect(isDivergenceClass('indeterminate')).toBe(true);
    expect(isDivergenceClass('green')).toBe(false);
    expect(isDivergenceClass('')).toBe(false);
    expect(isDivergenceClass(null)).toBe(false);
    expect(isDivergenceClass(42)).toBe(false);
  });
});

describe('finalizeStatusToVerdict', () => {
  it('maps terminal-green statuses to green', () => {
    expect(finalizeStatusToVerdict('ready_to_push')).toBe('green');
    expect(finalizeStatusToVerdict('pushed')).toBe('green');
  });
  it('maps terminal-red statuses to red', () => {
    expect(finalizeStatusToVerdict('failed')).toBe('red');
    expect(finalizeStatusToVerdict('timed_out')).toBe('red');
    expect(finalizeStatusToVerdict('stalled_no_response')).toBe('red');
  });
  it('maps in-flight and ambiguous statuses to unknown', () => {
    for (const s of [
      'queued',
      'rebasing',
      'reviewing',
      'running',
      'dispatching',
      'pushing',
      'infra_error',
      'cancelled',
    ] as const) {
      expect(finalizeStatusToVerdict(s), s).toBe('unknown');
    }
  });
});

describe('githubChecksToVerdict', () => {
  it('returns unknown for no checks', () => {
    expect(githubChecksToVerdict([])).toBe('unknown');
    expect(githubChecksToVerdict(undefined as unknown as [])).toBe('unknown');
  });

  it('returns green when every check completed successfully', () => {
    expect(
      githubChecksToVerdict([
        { name: 'backend', status: 'completed', conclusion: 'success' },
        { name: 'frontend', status: 'completed', conclusion: 'success' },
      ]),
    ).toBe('green');
  });

  it('treats neutral and skipped as passing', () => {
    expect(
      githubChecksToVerdict([
        { name: 'a', status: 'completed', conclusion: 'success' },
        { name: 'b', status: 'completed', conclusion: 'neutral' },
        { name: 'c', status: 'completed', conclusion: 'skipped' },
      ]),
    ).toBe('green');
  });

  it('returns red when any check failed', () => {
    expect(
      githubChecksToVerdict([
        { name: 'backend', status: 'completed', conclusion: 'success' },
        { name: 'e2e', status: 'completed', conclusion: 'failure' },
      ]),
    ).toBe('red');
  });

  it('treats timed_out / action_required / cancelled / startup_failure / stale as red', () => {
    for (const conclusion of [
      'timed_out',
      'action_required',
      'cancelled',
      'startup_failure',
      'stale',
    ]) {
      expect(
        githubChecksToVerdict([{ name: 'x', status: 'completed', conclusion }]),
        conclusion,
      ).toBe('red');
    }
  });

  it('lets a failure dominate an in-progress check (already red)', () => {
    expect(
      githubChecksToVerdict([
        { name: 'a', status: 'in_progress', conclusion: null },
        { name: 'b', status: 'completed', conclusion: 'failure' },
      ]),
    ).toBe('red');
  });

  it('returns unknown when a check is still running and none failed', () => {
    expect(
      githubChecksToVerdict([
        { name: 'a', status: 'completed', conclusion: 'success' },
        { name: 'b', status: 'in_progress', conclusion: null },
      ]),
    ).toBe('unknown');
  });

  it('treats an unrecognized terminal conclusion as not-green (red)', () => {
    expect(
      githubChecksToVerdict([{ name: 'x', status: 'completed', conclusion: 'something_new' }]),
    ).toBe('red');
  });

  it('reproduces PR#1001: 3 GitHub failures => red, vs Finalize green => false_green', () => {
    const githubVerdict = githubChecksToVerdict([
      { name: 'backend', status: 'completed', conclusion: 'failure' },
      { name: 'frontend', status: 'completed', conclusion: 'failure' },
      { name: 'e2e', status: 'completed', conclusion: 'failure' },
    ]);
    const finalizeVerdict = finalizeStatusToVerdict('ready_to_push');
    expect(githubVerdict).toBe('red');
    expect(finalizeVerdict).toBe('green');
    expect(classifyDivergence(finalizeVerdict, githubVerdict)).toBe('false_green');
  });
});

describe('per-job normalizers', () => {
  it('normalizes Finalize job states', () => {
    expect(normalizeFinalizeJobState('passed')).toBe('green');
    expect(normalizeFinalizeJobState('failed')).toBe('red');
    expect(normalizeFinalizeJobState('skipped')).toBe('skipped');
    expect(normalizeFinalizeJobState('queued')).toBe('unknown');
    expect(normalizeFinalizeJobState('running')).toBe('unknown');
  });

  it('normalizes GitHub check states', () => {
    expect(normalizeGithubCheckState('completed', 'success')).toBe('green');
    expect(normalizeGithubCheckState('completed', 'failure')).toBe('red');
    expect(normalizeGithubCheckState('completed', 'skipped')).toBe('skipped');
    expect(normalizeGithubCheckState('completed', 'neutral')).toBe('skipped');
    expect(normalizeGithubCheckState('in_progress', null)).toBe('unknown');
  });

  it('projects Finalize job rows into parity jobs', () => {
    expect(
      finalizeJobsToParityJobs([
        { name: 'backend', state: 'passed' },
        { name: 'e2e', state: 'failed' },
      ]),
    ).toEqual([
      { name: 'backend', state: 'green' },
      { name: 'e2e', state: 'red' },
    ]);
  });

  it('projects GitHub check-runs into parity jobs', () => {
    expect(
      githubChecksToParityJobs([
        { name: 'backend', status: 'completed', conclusion: 'failure' },
        { name: 'frontend', status: 'completed', conclusion: 'success' },
      ]),
    ).toEqual([
      { name: 'backend', state: 'red' },
      { name: 'frontend', state: 'green' },
    ]);
  });

  it('tolerates malformed check entries', () => {
    expect(githubChecksToParityJobs([null, {}, 7] as unknown[])).toEqual([
      { name: '', state: 'unknown' },
      { name: '', state: 'unknown' },
      { name: '', state: 'unknown' },
    ]);
  });
});

type ParityIn = 'green' | 'red' | 'unknown';
