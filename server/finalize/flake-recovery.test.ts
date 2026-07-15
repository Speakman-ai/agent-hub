import { describe, it, expect } from 'vitest';
import {
  classifyJobRetryHistory,
  matchesAnyGlob,
  flakeRecoveredVerdicts,
  serializeFlakeRecovered,
  parseFlakeRecovered,
  hasFlakeRecoveredJobs,
  describeFlakeRecovered,
  gateResultFromVerdicts,
  blockedGateResult,
  serializeFlakeGate,
  parseFlakeGate,
  flakeGateBlocksAutoPush,
  withIntraPhaseFlakeRecovered,
  type FlakeGateResult,
  type JobRoundAttempt,
  type ClassifyDeps,
} from './flake-recovery.js';

// A change-set resolver that never finds a relevant change (every range is
// empty) — recoveries are always laundered flakes.
const noChange: ClassifyDeps = { changedFilesBetween: () => [] };

function attempt(
  jobId: string,
  round: number,
  state: JobRoundAttempt['state'],
  headSha: string | null = `h${round}`,
  matrixKey = '',
): JobRoundAttempt {
  return { jobId, matrixKey, round, state, headSha };
}

describe('matchesAnyGlob', () => {
  it('matches a literal path', () => {
    expect(matchesAnyGlob('server/index.ts', ['server/index.ts'])).toBe(true);
    expect(matchesAnyGlob('server/index.ts', ['server/other.ts'])).toBe(false);
  });

  it('* matches within a segment but not across /', () => {
    expect(matchesAnyGlob('server/index.ts', ['server/*.ts'])).toBe(true);
    expect(matchesAnyGlob('server/sub/index.ts', ['server/*.ts'])).toBe(false);
  });

  it('** spans path segments', () => {
    expect(matchesAnyGlob('server/a/b/c.ts', ['server/**'])).toBe(true);
    expect(matchesAnyGlob('server/a/b/c.ts', ['server/**/*.ts'])).toBe(true);
    expect(matchesAnyGlob('client/a.ts', ['server/**'])).toBe(false);
  });

  it('treats a trailing slash as a directory prefix', () => {
    expect(matchesAnyGlob('server/finalize/x.ts', ['server/'])).toBe(true);
    expect(matchesAnyGlob('client/x.ts', ['server/'])).toBe(false);
  });

  it('normalizes ./ and leading slashes', () => {
    expect(matchesAnyGlob('./server/x.ts', ['server/**'])).toBe(true);
    expect(matchesAnyGlob('/server/x.ts', ['server/**'])).toBe(true);
  });

  it('ignores empty globs', () => {
    expect(matchesAnyGlob('a.ts', ['', '   '])).toBe(false);
  });

  it('? matches a single non-slash char', () => {
    expect(matchesAnyGlob('a1.ts', ['a?.ts'])).toBe(true);
    expect(matchesAnyGlob('a/.ts', ['a?.ts'])).toBe(false);
  });
});

describe('classifyJobRetryHistory — basic outcomes', () => {
  it('passes first time → clean', () => {
    const v = classifyJobRetryHistory([attempt('backend', 1, 'passed')], noChange);
    expect(v).toHaveLength(1);
    expect(v[0].classification).toBe('clean');
    expect(v[0].failureCount).toBe(0);
    expect(v[0].passedRound).toBe(1);
  });

  it('final state failed → failed', () => {
    const v = classifyJobRetryHistory(
      [attempt('backend', 1, 'failed'), attempt('backend', 2, 'failed')],
      noChange,
    );
    expect(v[0].classification).toBe('failed');
    expect(v[0].failedRounds).toEqual([1, 2]);
    expect(v[0].passedRound).toBeNull();
  });

  it('only queued/running observed → clean (not merge-relevant)', () => {
    const v = classifyJobRetryHistory(
      [attempt('backend', 1, 'queued'), attempt('backend', 1, 'running')],
      noChange,
    );
    expect(v[0].classification).toBe('clean');
  });

  it('ignores non-terminal observations when a terminal one exists', () => {
    const v = classifyJobRetryHistory(
      [attempt('backend', 1, 'running'), attempt('backend', 1, 'passed')],
      noChange,
    );
    expect(v[0].classification).toBe('clean');
  });
});

describe('classifyJobRetryHistory — flake recovery detection', () => {
  it('failed then passed with NO code change → flake_recovered', () => {
    const v = classifyJobRetryHistory(
      [attempt('e2e', 1, 'failed', 'h1'), attempt('e2e', 2, 'passed', 'h1')],
      noChange,
    );
    expect(v[0].classification).toBe('flake_recovered');
    expect(v[0].failureCount).toBe(1);
    expect(v[0].failedRounds).toEqual([1]);
    expect(v[0].passedRound).toBe(2);
  });

  it('identical head between fail and pass → flake_recovered even if resolver would find files', () => {
    const deps: ClassifyDeps = { changedFilesBetween: () => ['server/x.ts'] };
    const v = classifyJobRetryHistory(
      [attempt('e2e', 1, 'failed', 'sameHead'), attempt('e2e', 2, 'passed', 'sameHead')],
      deps,
    );
    expect(v[0].classification).toBe('flake_recovered');
  });

  it('counts multiple failures before the pass', () => {
    const v = classifyJobRetryHistory(
      [
        attempt('e2e', 1, 'failed', 'h1'),
        attempt('e2e', 2, 'failed', 'h2'),
        attempt('e2e', 3, 'passed', 'h2'),
      ],
      noChange,
    );
    expect(v[0].classification).toBe('flake_recovered');
    expect(v[0].failureCount).toBe(2);
    expect(v[0].failedRounds).toEqual([1, 2]);
  });

  it('changed range cannot be resolved (null) → unresolved (fail closed)', () => {
    const deps: ClassifyDeps = { changedFilesBetween: () => null };
    const v = classifyJobRetryHistory(
      [attempt('e2e', 1, 'failed', 'h1'), attempt('e2e', 2, 'passed', 'h2')],
      deps,
    );
    expect(v[0].classification).toBe('unresolved');
    // ...and an unresolved recovery blocks the gate rather than reading clean.
    expect(gateResultFromVerdicts(v).status).toBe('blocked');
  });

  it('code changed, no declared paths → fixed (cannot disprove)', () => {
    const deps: ClassifyDeps = { changedFilesBetween: () => ['server/backend/api.ts'] };
    const v = classifyJobRetryHistory(
      [attempt('e2e', 1, 'failed', 'h1'), attempt('e2e', 2, 'passed', 'h2')],
      deps,
    );
    expect(v[0].classification).toBe('fixed');
  });
});

describe('classifyJobRetryHistory — path-scoped detection', () => {
  const deps = (files: string[]): ClassifyDeps => ({
    changedFilesBetween: () => files,
    jobPaths: new Map([
      ['e2e', ['e2e/**', 'client/**']],
      ['backend', ['server/**']],
    ]),
  });

  it('fixer touched the job paths → fixed', () => {
    const v = classifyJobRetryHistory(
      [attempt('e2e', 1, 'failed', 'h1'), attempt('e2e', 2, 'passed', 'h2')],
      deps(['client/app.jsx']),
    );
    expect(v[0].classification).toBe('fixed');
  });

  it('fixer touched UNRELATED paths → flake_recovered (laundered)', () => {
    // The classic bug: a fix to `server/**` (backend) lands, e2e gets re-run
    // and flips green even though nothing in e2e's paths changed.
    const v = classifyJobRetryHistory(
      [attempt('e2e', 1, 'failed', 'h1'), attempt('e2e', 2, 'passed', 'h2')],
      deps(['server/backend/api.ts']),
    );
    expect(v[0].classification).toBe('flake_recovered');
  });

  it('mixed change-set where one file matches → fixed', () => {
    const v = classifyJobRetryHistory(
      [attempt('e2e', 1, 'failed', 'h1'), attempt('e2e', 2, 'passed', 'h2')],
      deps(['server/backend/api.ts', 'e2e/tests/login.spec.js']),
    );
    expect(v[0].classification).toBe('fixed');
  });
});

describe('classifyJobRetryHistory — matrix shards are independent', () => {
  it('classifies each matrix shard separately', () => {
    const attempts: JobRoundAttempt[] = [
      attempt('e2e', 1, 'failed', 'h1', 'shard-1'),
      attempt('e2e', 2, 'passed', 'h1', 'shard-1'), // flake recovered
      attempt('e2e', 1, 'passed', 'h1', 'shard-2'), // clean
    ];
    const v = classifyJobRetryHistory(attempts, noChange);
    const s1 = v.find((x) => x.matrixKey === 'shard-1')!;
    const s2 = v.find((x) => x.matrixKey === 'shard-2')!;
    expect(s1.classification).toBe('flake_recovered');
    expect(s2.classification).toBe('clean');
  });
});

describe('summary + persistence helpers', () => {
  const verdicts = classifyJobRetryHistory(
    [
      attempt('e2e', 1, 'failed', 'h1'),
      attempt('e2e', 2, 'passed', 'h1'), // flake recovered
      attempt('backend', 1, 'passed', 'h1'), // clean
    ],
    noChange,
  );

  it('flakeRecoveredVerdicts filters to just the recovered ones', () => {
    expect(flakeRecoveredVerdicts(verdicts).map((v) => v.jobId)).toEqual(['e2e']);
  });

  it('serialize → parse round-trips only the flake-recovered verdicts', () => {
    const json = serializeFlakeRecovered(verdicts);
    expect(json).toBeTypeOf('string');
    const parsed = parseFlakeRecovered(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].jobId).toBe('e2e');
    expect(parsed[0].classification).toBe('flake_recovered');
  });

  it('serialize returns null when there are no flake-recovered jobs', () => {
    const clean = classifyJobRetryHistory([attempt('backend', 1, 'passed')], noChange);
    expect(serializeFlakeRecovered(clean)).toBeNull();
  });

  it('parseFlakeRecovered tolerates null / garbage', () => {
    expect(parseFlakeRecovered(null)).toEqual([]);
    expect(parseFlakeRecovered('not json')).toEqual([]);
    expect(parseFlakeRecovered('{"not":"array"}')).toEqual([]);
    expect(parseFlakeRecovered('[{"jobId":"x","classification":"fixed"}]')).toEqual([]);
  });

  it('hasFlakeRecoveredJobs gates the auto-push decision', () => {
    expect(hasFlakeRecoveredJobs({ flake_recovered_jobs: serializeFlakeRecovered(verdicts) })).toBe(
      true,
    );
    expect(hasFlakeRecoveredJobs({ flake_recovered_jobs: null })).toBe(false);
    expect(hasFlakeRecoveredJobs(null)).toBe(false);
    expect(hasFlakeRecoveredJobs(undefined)).toBe(false);
  });

  it('describeFlakeRecovered produces a readable one-liner', () => {
    expect(describeFlakeRecovered(verdicts)).toBe('e2e passed on retry after 1 failure');
    const multi = classifyJobRetryHistory(
      [
        attempt('e2e', 1, 'failed', 'h1'),
        attempt('e2e', 2, 'failed', 'h2'),
        attempt('e2e', 3, 'passed', 'h2'),
      ],
      noChange,
    );
    expect(describeFlakeRecovered(multi)).toBe('e2e passed on retry after 2 failures');
    expect(describeFlakeRecovered([])).toBe('no flake-recovered jobs');
  });
});

describe('flake gate status + fail-closed semantics', () => {
  const flakeVerdicts = classifyJobRetryHistory(
    [attempt('e2e', 1, 'failed', 'h1'), attempt('e2e', 2, 'passed', 'h1')],
    noChange,
  );

  it('gateResultFromVerdicts maps clean vs flake_recovered', () => {
    expect(gateResultFromVerdicts(flakeVerdicts).status).toBe('flake_recovered');
    const clean = classifyJobRetryHistory([attempt('backend', 1, 'passed')], noChange);
    expect(gateResultFromVerdicts(clean)).toEqual({ status: 'clean', jobs: [] });
  });

  it('gateResultFromVerdicts blocks on an unresolved recovery (fail closed)', () => {
    // A recovered job whose change-set could not be resolved.
    const unresolved = classifyJobRetryHistory(
      [attempt('e2e', 1, 'failed', 'h1'), attempt('e2e', 2, 'passed', 'h2')],
      { changedFilesBetween: () => null },
    );
    const gate = gateResultFromVerdicts(unresolved);
    expect(gate.status).toBe('blocked');
    expect(gate.jobs).toEqual([]);
    expect(gate.reason).toContain('e2e');
  });

  it('a definite flake_recovered takes priority over an unresolved job', () => {
    // e2e: identical head → flake_recovered; api: null range → unresolved.
    const verdicts = classifyJobRetryHistory(
      [
        attempt('e2e', 1, 'failed', 'same'),
        attempt('e2e', 2, 'passed', 'same'),
        attempt('api', 1, 'failed', 'h1'),
        attempt('api', 2, 'passed', 'h2'),
      ],
      { changedFilesBetween: () => null },
    );
    const gate = gateResultFromVerdicts(verdicts);
    expect(gate.status).toBe('flake_recovered');
    expect(gate.jobs.map((v) => v.jobId)).toContain('e2e');
  });

  it('serializeFlakeGate: clean → null, non-clean → JSON object', () => {
    expect(serializeFlakeGate({ status: 'clean', jobs: [] })).toBeNull();
    const blockedJson = serializeFlakeGate(blockedGateResult('history missing'));
    expect(JSON.parse(blockedJson!)).toMatchObject({
      status: 'blocked',
      reason: 'history missing',
    });
    const flakeJson = serializeFlakeGate(gateResultFromVerdicts(flakeVerdicts));
    expect(JSON.parse(flakeJson!).status).toBe('flake_recovered');
  });

  it('parseFlakeGate round-trips and fails closed on garbage', () => {
    expect(parseFlakeGate(null)).toEqual({ status: 'clean', jobs: [] });
    expect(parseFlakeGate('')).toEqual({ status: 'clean', jobs: [] });
    // Non-NULL but unparseable → blocked, NOT clean (the core fail-closed rule).
    expect(parseFlakeGate('not json').status).toBe('blocked');
    expect(parseFlakeGate('{"status":"bogus"}').status).toBe('blocked');
    const blocked = parseFlakeGate(serializeFlakeGate(blockedGateResult('x')));
    expect(blocked.status).toBe('blocked');
    expect(blocked.reason).toBe('x');
  });

  it('flakeGateBlocksAutoPush blocks everything except a proven-clean gate', () => {
    // clean (NULL) → allowed
    expect(flakeGateBlocksAutoPush({ flake_recovered_jobs: null })).toBe(false);
    expect(flakeGateBlocksAutoPush(null)).toBe(false);
    // flake_recovered → blocked
    expect(
      flakeGateBlocksAutoPush({
        flake_recovered_jobs: serializeFlakeGate(gateResultFromVerdicts(flakeVerdicts)),
      }),
    ).toBe(true);
    // blocked → blocked
    expect(
      flakeGateBlocksAutoPush({
        flake_recovered_jobs: serializeFlakeGate(blockedGateResult('cannot classify')),
      }),
    ).toBe(true);
    // unparseable non-NULL → blocked (fail closed)
    expect(flakeGateBlocksAutoPush({ flake_recovered_jobs: 'corrupt' })).toBe(true);
  });

  it('hasFlakeRecoveredJobs is true only for actual verdicts, not a bare block', () => {
    expect(
      hasFlakeRecoveredJobs({
        flake_recovered_jobs: serializeFlakeGate(blockedGateResult('x')),
      }),
    ).toBe(false);
    expect(
      hasFlakeRecoveredJobs({
        flake_recovered_jobs: serializeFlakeGate(gateResultFromVerdicts(flakeVerdicts)),
      }),
    ).toBe(true);
  });
});

describe('withIntraPhaseFlakeRecovered', () => {
  const clean: FlakeGateResult = { status: 'clean', jobs: [] };

  it('returns the gate unchanged when there are no intra-phase flakes', () => {
    expect(withIntraPhaseFlakeRecovered(clean, [])).toBe(clean);
  });

  it('promotes a clean gate to flake_recovered and lists the instance', () => {
    const result = withIntraPhaseFlakeRecovered(clean, [
      { jobId: 'server', matrixKey: '3/6', failureCount: 1 },
    ]);
    expect(result.status).toBe('flake_recovered');
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      jobId: 'server',
      matrixKey: '3/6',
      classification: 'flake_recovered',
      failureCount: 1,
    });
    // A promoted gate serializes non-null → blocks auto-push.
    expect(flakeGateBlocksAutoPush({ flake_recovered_jobs: serializeFlakeGate(result) })).toBe(
      true,
    );
  });

  it('leaves a blocked gate untouched (already fail-closed)', () => {
    const blocked = blockedGateResult('history unavailable');
    const result = withIntraPhaseFlakeRecovered(blocked, [
      { jobId: 'server', matrixKey: '', failureCount: 2 },
    ]);
    expect(result).toBe(blocked);
    expect(result.status).toBe('blocked');
  });

  it('unions with existing cross-round verdicts and de-dupes by instance', () => {
    const crossRound: FlakeGateResult = {
      status: 'flake_recovered',
      jobs: [
        {
          jobId: 'server',
          matrixKey: '1/6',
          classification: 'flake_recovered',
          failedRounds: [1],
          passedRound: 2,
          failureCount: 1,
        },
      ],
    };
    const result = withIntraPhaseFlakeRecovered(crossRound, [
      // Same instance as the cross-round verdict → de-duped (not added twice).
      { jobId: 'server', matrixKey: '1/6', failureCount: 3 },
      // New instance → appended.
      { jobId: 'e2e', matrixKey: '2/4', failureCount: 1 },
    ]);
    expect(result.status).toBe('flake_recovered');
    expect(result.jobs.map((j) => `${j.jobId} ${j.matrixKey}`).sort()).toEqual([
      'e2e 2/4',
      'server 1/6',
    ]);
  });
});
