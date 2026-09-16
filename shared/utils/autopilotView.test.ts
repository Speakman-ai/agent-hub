import { describe, it, expect } from 'vitest';
import {
  deriveAutopilotView,
  deriveReadiness,
  deriveControls,
  deriveRunView,
  deriveEvidenceView,
  deriveDocumentationView,
  deriveActivityLog,
  isReady,
  isActiveRun,
  formatWallTime,
  formatUsage,
  stageLabel,
  controlStateLabel,
  shortSha,
  msToHours,
  hoursToMs,
  msToMinutes,
  minutesToMs,
  parseAutopilotCostCap,
  validateAutopilotLimitsForm,
  type AutopilotProjectStateWire,
  type AutopilotConfigWire,
  type AutopilotRunWire,
} from './autopilotView';

const LIMITS = {
  cycleMode: 'continuous' as const,
  maxCycles: null,
  maxWallTimeMs: 4 * 60 * 60 * 1000,
  maxStageTimeoutMs: 30 * 60 * 1000,
  maxRetriesPerStage: 2,
  maxCostUsd: null,
};

function config(overrides: Partial<AutopilotConfigWire> = {}): AutopilotConfigWire {
  return {
    projectId: 'p1',
    enabled: false,
    disabling: false,
    briefId: null,
    brief: null,
    briefRevision: null,
    target: null,
    limits: null,
    credentialOwnerUserId: null,
    updatedAt: '2026-09-15T00:00:00.000Z',
    updatedBy: null,
    revision: 0,
    isolationAdapter: 'auto',
    hostAdapterAck: false,
    ...overrides,
  };
}

function readyConfig(overrides: Partial<AutopilotConfigWire> = {}): AutopilotConfigWire {
  return config({
    enabled: true,
    brief: 'Build a todo app with a browser-testable main flow.',
    briefId: 'brief-1',
    briefRevision: 1,
    target: {
      targetId: 'local',
      origin: 'http://127.0.0.1:8080',
      readinessProbeUrl: 'http://127.0.0.1:8080/health',
    },
    limits: LIMITS,
    credentialOwnerUserId: 'user-1',
    ...overrides,
  });
}

function run(overrides: Partial<AutopilotRunWire> = {}): AutopilotRunWire {
  return {
    id: 'run-1',
    projectId: 'p1',
    controlState: 'running',
    stage: 'implementing',
    cycleNumber: 2,
    pauseReason: null,
    failureReason: null,
    lastVerifiedSha: 'abcdef1234567890',
    lastDeploymentId: 'dep-1',
    targetId: 'local',
    limits: LIMITS,
    usage: { wallTimeMs: 90 * 60 * 1000, costUsd: null, costAvailable: false },
    startedBy: 'user-1',
    startedAt: '2026-09-15T00:00:00.000Z',
    stoppedAt: null,
    updatedAt: '2026-09-15T01:30:00.000Z',
    ...overrides,
  };
}

function state(overrides: Partial<AutopilotProjectStateWire> = {}): AutopilotProjectStateWire {
  return {
    config: config(),
    activeRun: null,
    ...overrides,
  };
}

describe('formatters', () => {
  it('formats wall time with hours/minutes/seconds', () => {
    expect(formatWallTime(0)).toBe('0s');
    expect(formatWallTime(8_000)).toBe('8s');
    expect(formatWallTime(90_000)).toBe('1m 30s');
    expect(formatWallTime(2 * 3600_000 + 5 * 60_000)).toBe('2h 05m');
    expect(formatWallTime(null)).toBe('0s');
    expect(formatWallTime(-5)).toBe('0s');
  });

  it('reports cost honestly when unavailable', () => {
    expect(formatUsage({ wallTimeMs: 60_000, costUsd: null, costAvailable: false })).toBe(
      '1m 00s · cost unavailable',
    );
    expect(formatUsage({ wallTimeMs: 60_000, costUsd: 1.5, costAvailable: true })).toBe(
      '1m 00s · $1.50',
    );
    // costAvailable false wins even if a stray number is present
    expect(formatUsage({ wallTimeMs: 0, costUsd: 3, costAvailable: false })).toBe(
      '0s · cost unavailable',
    );
  });

  it('labels stages and control states, truncates sha', () => {
    expect(stageLabel('selecting-next')).toBe('Selecting next improvement');
    expect(stageLabel(null)).toBe('Idle');
    expect(controlStateLabel('stopping')).toBe('Stopping');
    expect(controlStateLabel(null)).toBe('Idle');
    expect(shortSha('abcdef1234567890')).toBe('abcdef1234');
    expect(shortSha(null)).toBe('—');
  });

  it('parses cost caps, reserving null for an empty field and rejecting invalid input', () => {
    expect(parseAutopilotCostCap('')).toEqual({ ok: true, value: null });
    expect(parseAutopilotCostCap('   ')).toEqual({ ok: true, value: null });
    expect(parseAutopilotCostCap(null)).toEqual({ ok: true, value: null });
    expect(parseAutopilotCostCap('5')).toEqual({ ok: true, value: 5 });
    expect(parseAutopilotCostCap('2.5')).toEqual({ ok: true, value: 2.5 });
    // Invalid nonempty input must be rejected, never coerced to null (which
    // would silently clear an existing cap).
    expect(parseAutopilotCostCap('0')).toEqual({ ok: false });
    expect(parseAutopilotCostCap('-1')).toEqual({ ok: false });
    expect(parseAutopilotCostCap('abc')).toEqual({ ok: false });
    expect(parseAutopilotCostCap('NaN')).toEqual({ ok: false });
  });

  it('validates every numeric limit field, rejecting invalid input', () => {
    const valid = {
      cycleMode: 'continuous' as const,
      maxCycles: '',
      maxWallTimeHours: '4',
      maxStageTimeoutMinutes: '30',
      maxRetriesPerStage: '2',
      maxCostUsd: '',
    };
    expect(validateAutopilotLimitsForm(valid)).toEqual({ ok: true });
    // finite mode requires a positive integer cycle count
    expect(validateAutopilotLimitsForm({ ...valid, cycleMode: 'finite', maxCycles: '3' })).toEqual({
      ok: true,
    });

    const rejects = (over: Record<string, string>) =>
      expect(validateAutopilotLimitsForm({ ...valid, ...over }).ok).toBe(false);
    rejects({ maxCostUsd: '0' });
    rejects({ maxWallTimeHours: '0' });
    rejects({ maxWallTimeHours: 'abc' });
    rejects({ maxStageTimeoutMinutes: '-5' });
    rejects({ maxRetriesPerStage: '3' });
    rejects({ maxRetriesPerStage: '1.5' });
    rejects({ cycleMode: 'finite', maxCycles: '0' });
    rejects({ cycleMode: 'finite', maxCycles: '' });
  });

  it('round-trips limit unit conversions', () => {
    expect(msToHours(3_600_000)).toBe(1);
    expect(hoursToMs(2)).toBe(7_200_000);
    expect(msToMinutes(90_000)).toBe(1.5);
    expect(minutesToMs(30)).toBe(1_800_000);
    expect(hoursToMs(msToHours(4 * 3_600_000))).toBe(4 * 3_600_000);
  });
});

describe('deriveReadiness', () => {
  it('flags every missing requirement on a fresh project', () => {
    const items = deriveReadiness(state({ config: config() }));
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.ok]));
    expect(byKey).toEqual({
      brief: false,
      target: false,
      origin: false,
      readiness: false,
      limits: false,
      owner: false,
    });
    expect(isReady(state())).toBe(false);
  });

  it('is fully ready when config complete', () => {
    const s = state({ config: readyConfig() });
    expect(deriveReadiness(s).every((i) => i.ok)).toBe(true);
    expect(isReady(s)).toBe(true);
  });

  it('flags a target that is missing its readiness probe', () => {
    const s = state({
      config: readyConfig({
        target: { targetId: 'local', origin: 'http://127.0.0.1:8080', readinessProbeUrl: null },
      }),
    });
    expect(deriveReadiness(s).find((i) => i.key === 'readiness')?.ok).toBe(false);
    expect(isReady(s)).toBe(false);
  });
});

describe('deriveControls', () => {
  it('allows start only when ready, enabled and no active run', () => {
    expect(deriveControls(state({ config: readyConfig() })).canStart).toBe(true);
    // not enabled
    expect(deriveControls(state({ config: readyConfig({ enabled: false }) })).canStart).toBe(false);
    // not ready (no brief)
    expect(
      deriveControls(state({ config: readyConfig({ brief: null, briefId: null }) })).canStart,
    ).toBe(false);
  });

  it('offers pause while running and stop while active, not while stopping', () => {
    const running = state({
      config: readyConfig(),
      activeRun: { run: run({ controlState: 'running' }), cycle: null },
    });
    const c = deriveControls(running);
    expect(c.canPause).toBe(true);
    expect(c.canStop).toBe(true);
    expect(c.canResume).toBe(false);
    expect(c.canStart).toBe(false);
    expect(c.isActive).toBe(true);
    expect(c.stopping).toBe(false);
  });

  it('offers resume while paused', () => {
    const paused = state({
      config: readyConfig(),
      activeRun: { run: run({ controlState: 'paused', stage: null }), cycle: null },
    });
    const c = deriveControls(paused);
    expect(c.canResume).toBe(true);
    expect(c.canPause).toBe(false);
    expect(c.canStop).toBe(true);
  });

  it('reports stopping and withdraws stop while cancellation settles', () => {
    const stopping = state({
      config: readyConfig(),
      activeRun: { run: run({ controlState: 'stopping' }), cycle: null },
    });
    const c = deriveControls(stopping);
    expect(c.stopping).toBe(true);
    expect(c.canStop).toBe(false);
    expect(c.canPause).toBe(false);
    expect(c.isActive).toBe(true);
  });

  it('treats a disabling project as settling and blocks start/resume', () => {
    const disabling = state({ config: readyConfig({ disabling: true }) });
    const c = deriveControls(disabling);
    expect(c.stopping).toBe(true);
    expect(c.canStart).toBe(false);
    expect(c.canDisable).toBe(false);
  });

  it('isActiveRun matches the active control states', () => {
    expect(isActiveRun(run({ controlState: 'running' }))).toBe(true);
    expect(isActiveRun(run({ controlState: 'paused' }))).toBe(true);
    expect(isActiveRun(run({ controlState: 'stopping' }))).toBe(true);
    expect(isActiveRun(run({ controlState: 'stopped' }))).toBe(false);
    expect(isActiveRun(run({ controlState: 'failed' }))).toBe(false);
    expect(isActiveRun(null)).toBe(false);
  });
});

describe('deriveRunView', () => {
  it('returns null with no active run', () => {
    expect(deriveRunView(state())).toBeNull();
  });

  it('summarizes stage, cycle, deployed URL, verified sha, evidence and docs', () => {
    const s = state({
      config: readyConfig(),
      activeRun: {
        run: run(),
        cycle: {
          cycleNumber: 2,
          selectedImprovement: 'Speed up the list render',
          verification: { passed: true },
          documentation: { journal: 'cycle 2' },
          outcome: 'succeeded',
          status: 'succeeded',
          testedCommitSha: 'abcdef1234567890',
          deploymentId: 'dep-1',
        },
      },
    });
    const v = deriveRunView(s)!;
    expect(v.stageLabel).toBe('Implementing');
    expect(v.cycleNumber).toBe(2);
    expect(v.deployedUrl).toBe('http://127.0.0.1:8080');
    expect(v.lastVerifiedShaShort).toBe('abcdef1234');
    expect(v.selectedImprovement).toBe('Speed up the list render');
    expect(v.hasEvidence).toBe(true);
    expect(v.hasDocumentation).toBe(true);
    expect(v.usageText).toBe('1h 30m · cost unavailable');
    expect(v.stopping).toBe(false);
  });

  it('surfaces the failure reason on a failed run', () => {
    const s = state({
      config: readyConfig(),
      activeRun: {
        run: run({
          controlState: 'failed',
          failureReason: 'verification failed',
          stage: 'verifying',
        }),
        cycle: null,
      },
    });
    const v = deriveRunView(s)!;
    expect(v.controlStateLabel).toBe('Failed');
    expect(v.failureReason).toBe('verification failed');
    expect(v.hasEvidence).toBe(false);
    expect(v.active).toBe(false);
  });

  it('does not claim a deployed URL when the run targets a different target', () => {
    const s = state({
      config: readyConfig(),
      activeRun: { run: run({ targetId: 'other' }), cycle: null },
    });
    expect(deriveRunView(s)!.deployedUrl).toBeNull();
  });

  it('labels leftover failed scorecard as last evaluation while the run is still implementing', () => {
    const s = state({
      config: readyConfig(),
      activeRun: {
        run: run({ controlState: 'running', stage: 'implementing' }),
        cycle: {
          cycleNumber: 1,
          selectedImprovement: null,
          verification: {
            judgement: { ok: false, reason: 'missing_evidence' },
            evidence: { observedSha: 'abc', origin: 'http://127.0.0.1:8188' },
          },
          documentation: null,
          outcome: null,
          status: 'active',
          testedCommitSha: 'abc',
          deploymentId: 'dep-1',
        },
        events: [
          {
            id: 'e1',
            type: 'resumed',
            createdAt: '2026-09-16T18:30:26.000Z',
            seq: 56,
          },
          {
            id: 'e2',
            type: 'operation_started',
            payload: { kind: 'implement' },
            createdAt: '2026-09-16T18:30:28.000Z',
            seq: 57,
            operationId: 'op-1',
          },
        ],
        operations: [
          {
            id: 'op-1',
            kind: 'implement',
            status: 'in_flight',
            sessionId: 'dd09bb4b-de76-434e-8938-0ef77f021441',
            createdAt: '2026-09-16T18:30:28.000Z',
            updatedAt: '2026-09-16T18:30:28.000Z',
          },
        ],
      },
    });
    const v = deriveRunView(s)!;
    expect(v.evidenceStale).toBe(true);
    expect(v.evidenceLabel).toBe('Last evaluation');
    expect(v.currentWork).toMatchObject({
      kind: 'implement',
      kindLabel: 'implement',
      sessionId: 'dd09bb4b-de76-434e-8938-0ef77f021441',
    });
    expect(v.activity[0]?.text).toMatch(/Started implement/);
    expect(v.activity[1]?.text).toBe('Resumed');
  });
});

describe('deriveEvidenceView', () => {
  it('returns null for absent verification', () => {
    expect(deriveEvidenceView(null)).toBeNull();
    expect(deriveEvidenceView(undefined)).toBeNull();
    expect(deriveEvidenceView('nope')).toBeNull();
  });

  it('projects a passing verdict with criteria and artifact refs', () => {
    const v = deriveEvidenceView({
      judgement: { ok: true, sha: 'deadbeef' },
      evidence: {
        expectedSha: 'deadbeef',
        observedSha: 'deadbeef',
        origin: 'http://127.0.0.1:8080',
        healthCheck: { url: 'http://127.0.0.1:8080/health', ok: true },
        usedPreview: false,
        criteria: [
          {
            criterionId: 'c1',
            passed: true,
            kind: 'browser',
            observed: 'list renders',
            screenshotPath: '/tmp/c1.png',
          },
        ],
      },
    })!;
    expect(v.verdict).toBe('passed');
    expect(v.observedSha).toBe('deadbeef');
    expect(v.origin).toBe('http://127.0.0.1:8080');
    expect(v.healthOk).toBe(true);
    expect(v.criteria).toHaveLength(1);
    expect(v.criteria[0].artifactRef).toBe('/tmp/c1.png');
    expect(v.criteria[0].passed).toBe(true);
  });

  it('captures failure evidence — reason, detail and failed criteria', () => {
    const v = deriveEvidenceView({
      judgement: {
        ok: false,
        reason: 'baseline_regression',
        detail: 'home journey broke',
        recover: true,
      },
      evidence: {
        origin: 'http://127.0.0.1:8080',
        criteria: [
          {
            criterionId: 'c1',
            passed: false,
            kind: 'browser',
            observed: 'blank page',
            tracePath: '/tmp/c1.zip',
          },
        ],
      },
    })!;
    expect(v.verdict).toBe('failed');
    expect(v.failureReason).toBe('baseline_regression');
    expect(v.failureDetail).toBe('home journey broke');
    expect(v.criteria[0].passed).toBe(false);
    expect(v.criteria[0].artifactRef).toBe('/tmp/c1.zip');
  });

  it('reports pending when no judgement is recorded yet', () => {
    expect(deriveEvidenceView({ evidence: { criteria: [] } })!.verdict).toBe('pending');
  });
});

describe('deriveDocumentationView', () => {
  it('returns null for absent documentation', () => {
    expect(deriveDocumentationView(null)).toBeNull();
  });

  it('projects benefit, change, decisions, links and evidence refs', () => {
    const d = deriveDocumentationView({
      expectedBenefit: 'faster list',
      actualChange: 'memoized rows',
      outcome: 'succeeded',
      nextAction: 'ship it',
      decisions: [{ key: 'arch', decision: 'use memo' }, { bad: true }],
      links: {
        deploymentOrigin: 'http://127.0.0.1:8080',
        testedCommitSha: 'abc123',
        cardId: 'card-1',
        sessionId: 'sess-1',
      },
      evidence: [
        { kind: 'screenshot', path: '/tmp/a.png' },
        { kind: 'trace', artifactId: 'art-1' },
      ],
      journalSlug: 'autopilot-journal',
      wikiSlugs: ['autopilot-runbook'],
    })!;
    expect(d.expectedBenefit).toBe('faster list');
    expect(d.actualChange).toBe('memoized rows');
    expect(d.outcome).toBe('succeeded');
    expect(d.decisions).toEqual([{ key: 'arch', decision: 'use memo' }]);
    const deploy = d.links.find((l) => l.label === 'Deployment')!;
    expect(deploy.href).toBe('http://127.0.0.1:8080');
    expect(d.links.find((l) => l.label === 'Tested commit')?.href).toBeNull();
    expect(d.evidenceRefs).toEqual([
      { kind: 'screenshot', ref: '/tmp/a.png' },
      { kind: 'trace', ref: 'art-1' },
    ]);
    expect(d.journalSlug).toBe('autopilot-journal');
    expect(d.wikiSlugs).toEqual(['autopilot-runbook']);
  });
});

describe('deriveAutopilotView', () => {
  it('composes readiness, controls and run into one view-model', () => {
    const s = state({
      config: readyConfig(),
      activeRun: { run: run({ controlState: 'paused', stage: null }), cycle: null },
    });
    const view = deriveAutopilotView(s);
    expect(view.enabled).toBe(true);
    expect(view.ready).toBe(true);
    expect(view.controls.canResume).toBe(true);
    expect(view.run?.controlState).toBe('paused');
  });
});

describe('deriveActivityLog', () => {
  it('renders newest-first operator lines from controller events', () => {
    const lines = deriveActivityLog(
      [
        {
          id: 'a',
          type: 'paused',
          payload: { reason: 'stage timeout envelope is exhausted' },
          createdAt: '2026-09-16T18:23:09.000Z',
          seq: 54,
        },
        {
          id: 'b',
          type: 'resumed',
          createdAt: '2026-09-16T18:30:26.000Z',
          seq: 56,
        },
        {
          id: 'c',
          type: 'operation_completed',
          payload: { outcome: 'failed' },
          createdAt: '2026-09-16T06:50:09.000Z',
          seq: 46,
          operationId: 'op-eval',
        },
      ],
      [
        {
          id: 'op-eval',
          kind: 'evaluate',
          status: 'failed',
          createdAt: '2026-09-16T06:43:17.000Z',
          updatedAt: '2026-09-16T06:50:09.000Z',
        },
      ],
    );
    expect(lines.map((l) => l.text)).toEqual([
      'Resumed',
      'Paused: stage timeout envelope is exhausted',
      'evaluate failed',
    ]);
    expect(lines[2]?.tone).toBe('error');
  });
});
