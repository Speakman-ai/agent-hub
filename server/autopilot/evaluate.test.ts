import { describe, expect, it } from 'vitest';
import {
  deriveCycleJourneys,
  judgeEvaluation,
  pinApiResponseAssertion,
  pinApiRequest,
  pinCriteriaFromSpec,
  shouldRecoverFromEvaluation,
  stampHubEvidence,
  writeCycleVerification,
  parseHubEvidence,
  verificationAllowsLastKnownGood,
  apiSatisfiesExpectedResult,
  AUTOPILOT_API_BODY_EXCERPT_CHARS,
  AUTOPILOT_API_BODY_MAX_CHARS,
  AUTOPILOT_EVAL_BROWSER_TRACE_KIND,
  boundApiResponseBody,
  isEvaluatorJourneyTrace,
  type AutopilotEvaluationReport,
  type AutopilotExecutionCapture,
  type AutopilotHubEvidence,
  type AutopilotPinnedCriteria,
} from './evaluate.js';
import type { AutopilotEvaluationSpec } from './evaluate.js';

const SPEC: AutopilotEvaluationSpec = {
  acceptanceJourneys: [
    { action: 'create a todo via the form', expectedResult: 'it appears in the list' },
    { action: 'GET /api/todos', expectedResult: 'returns the stored items as JSON' },
  ],
  qualityRubricVersion: 1,
};

const PINNED = pinCriteriaFromSpec(SPEC, 1);
const SHA = 'deadbeefcafe';
const ORIGIN = 'http://127.0.0.1:4310';
const NOW = new Date('2026-09-14T22:00:00.000Z');
const BINDING = { operationId: 'op-eval-1', deploymentId: 'dep-1' };
const FRESH_MTIME = Date.parse('2026-09-14T21:59:00.000Z');
const OP_STARTED = '2026-09-14T21:50:00.000Z';

function passingReport(
  overrides: Partial<AutopilotEvaluationReport> = {},
): AutopilotEvaluationReport {
  return {
    expectedSha: SHA,
    observedSha: SHA,
    origin: ORIGIN,
    healthCheck: { url: `${ORIGIN}/health`, ok: true },
    capturedAt: '2026-09-14T21:59:00.000Z',
    criteria: [
      {
        criterionId: 'baseline-1',
        passed: true,
        kind: 'browser_journey',
        screenshotPath: '/tmp/eval/todo.png',
        tracePath: '/tmp/eval/todo.trace',
        observed: 'new item appears in the list',
      },
      {
        criterionId: 'baseline-2',
        passed: true,
        kind: 'api_check',
        apiCheck: {
          method: 'GET',
          url: `${ORIGIN}/api/todos`,
          status: 200,
          bodyExcerpt: '[{"title":"x"}]',
        },
      },
    ],
    ...overrides,
  };
}

function executionCaptures(
  report: AutopilotEvaluationReport,
  opts?: { mtimeMs?: number; omitApi?: boolean; exists?: boolean },
): AutopilotExecutionCapture[] {
  const mtimeMs = opts?.mtimeMs ?? FRESH_MTIME;
  const out: AutopilotExecutionCapture[] = [];
  for (const ev of report.criteria) {
    if (ev.kind === 'browser_journey') {
      if (!ev.screenshotPath && !ev.tracePath) continue;
      out.push({
        captureId: `cap-${ev.criterionId}`,
        criterionId: ev.criterionId,
        kind: 'browser_journey',
        capturedAt: '2026-09-14T21:59:00.000Z',
        operationId: BINDING.operationId,
        deploymentId: BINDING.deploymentId,
        expectedSha: SHA,
        origin: ORIGIN,
        screenshot: ev.screenshotPath ? { path: ev.screenshotPath, mtimeMs } : null,
        trace: ev.tracePath ? { path: ev.tracePath, mtimeMs } : null,
        api: null,
      });
      continue;
    }
    if (opts?.omitApi) continue;
    if (!ev.apiCheck?.url) continue;
    out.push({
      captureId: `cap-${ev.criterionId}`,
      criterionId: ev.criterionId,
      kind: 'api_check',
      capturedAt: '2026-09-14T21:59:00.000Z',
      operationId: BINDING.operationId,
      deploymentId: BINDING.deploymentId,
      expectedSha: SHA,
      origin: ORIGIN,
      screenshot: null,
      trace: null,
      api: {
        requestId: `req-${ev.criterionId}`,
        method: ev.apiCheck.method,
        url: ev.apiCheck.url,
        status: ev.apiCheck.status,
        body: ev.apiCheck.body ?? ev.apiCheck.bodyExcerpt,
        bodyComplete: ev.apiCheck.bodyComplete,
        bodyExcerpt: ev.apiCheck.bodyExcerpt,
      },
    });
  }
  return out;
}

function hubFor(
  report: AutopilotEvaluationReport,
  opts?: {
    observedSha?: string;
    operationId?: string;
    exists?: boolean;
    mtimeMs?: number;
    omitApi?: boolean;
    captures?: AutopilotExecutionCapture[];
  },
): AutopilotHubEvidence {
  const stamped = stampHubEvidence({
    operationId: opts?.operationId ?? BINDING.operationId,
    deploymentId: BINDING.deploymentId,
    expectedSha: SHA,
    observedSha: opts?.observedSha ?? SHA,
    origin: ORIGIN,
    operationStartedAt: OP_STARTED,
    captures: opts?.captures ?? executionCaptures(report, opts),
    report,
    artifactExists: () => {
      if (opts?.exists === false) return { exists: false };
      return { exists: true, mtimeMs: opts?.mtimeMs ?? FRESH_MTIME, journeyTrace: true };
    },
  });
  if (!stamped) throw new Error('failed to stamp hub evidence');
  return stamped;
}

function judge(
  report: AutopilotEvaluationReport | null,
  extra: Partial<Parameters<typeof judgeEvaluation>[0]> = {},
) {
  return judgeEvaluation({
    pinned: PINNED,
    expectedSha: SHA,
    targetOrigin: ORIGIN,
    report,
    hubEvidence: report ? hubFor(report) : null,
    binding: BINDING,
    now: NOW,
    ...extra,
  });
}

describe('isEvaluatorJourneyTrace', () => {
  it('accepts a recorded interaction sequence and rejects a final-page snapshot', () => {
    expect(
      isEvaluatorJourneyTrace({
        kind: AUTOPILOT_EVAL_BROWSER_TRACE_KIND,
        actions: [
          { op: 'navigate', url: `${ORIGIN}/`, at: '2026-09-14T21:58:00.000Z', ok: true },
          { op: 'click', target: 'Add', at: '2026-09-14T21:58:10.000Z', ok: true },
        ],
      }),
    ).toBe(true);
    expect(
      isEvaluatorJourneyTrace({
        kind: AUTOPILOT_EVAL_BROWSER_TRACE_KIND,
        page: { url: `${ORIGIN}/todos`, title: 'Todos', textExcerpt: 'Buy milk' },
      }),
    ).toBe(false);
    expect(
      isEvaluatorJourneyTrace({
        kind: AUTOPILOT_EVAL_BROWSER_TRACE_KIND,
        actions: [{ op: 'screenshot', at: '2026-09-14T21:59:00.000Z', ok: true }],
      }),
    ).toBe(false);
  });
});

describe('deriveCycleJourneys', () => {
  it('pins the full baseline as this cycle when the primary card is in play', () => {
    const journeys = deriveCycleJourneys(
      SPEC,
      { cardId: 'card-1' },
      {
        primaryCardId: 'card-1',
        cards: [{ cardId: 'card-1' }, { cardId: 'card-2' }],
      },
    );
    expect(journeys).toHaveLength(2);
  });

  it('uses the selected improvement as the cycle-specific journey', () => {
    const journeys = deriveCycleJourneys(SPEC, {
      selectedImprovement: JSON.stringify({
        action: 'toggle a todo',
        expectedResult: 'it is marked complete',
      }),
    });
    expect(journeys).toEqual([
      { action: 'toggle a todo', expectedResult: 'it is marked complete' },
    ]);
  });
});

describe('pinCriteriaFromSpec', () => {
  it('pins baseline journeys before implementation and keeps cycle extras separate', () => {
    const pinned = pinCriteriaFromSpec(SPEC, 3, [
      { action: 'toggle a todo', expectedResult: 'it is marked complete' },
    ]);
    expect(pinned.specRevision).toBe(3);
    expect(pinned.criteria.map((c) => c.id)).toEqual(['baseline-1', 'baseline-2', 'cycle-1']);
    expect(pinned.criteria[0]?.source).toBe('baseline');
    expect(pinned.criteria[2]?.source).toBe('cycle');
    expect(pinned.criteria[1]?.kind).toBe('api_check');
    expect(pinned.criteria[1]?.apiAssertion).toEqual({
      json: true,
      nonempty: true,
      itemKind: 'todos',
    });
    expect(pinned.criteria[1]?.apiRequest).toEqual({ method: 'GET' });
  });

  it('pins a POST JSON body and content-type from the journey', () => {
    expect(
      pinApiRequest({
        action: 'POST /api/todos {"title":"Buy milk"}',
        expectedResult: 'returns the created todo as JSON',
      }),
    ).toEqual({
      method: 'POST',
      body: '{"title":"Buy milk"}',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('pins exact field values and empty-list length from the expected result', () => {
    expect(
      pinApiResponseAssertion({
        action: 'GET /api/health',
        expectedResult: 'returns JSON with ready true',
      }),
    ).toEqual({ json: true, fields: { ready: true } });
    expect(
      pinApiResponseAssertion({
        action: 'GET /api/todos',
        expectedResult: 'returns an empty JSON list',
      }),
    ).toEqual({ json: true, arrayLength: 0 });
  });
});

describe('judgeEvaluation', () => {
  it('promotes only when Hub-bound captures exist at the expected SHA', () => {
    const judgement = judge(passingReport());
    expect(judgement).toEqual({ ok: true, sha: SHA });
  });

  it('rejects a worker report that is not bound to this operation and deployment', () => {
    const report = passingReport();
    const judgement = judgeEvaluation({
      pinned: PINNED,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: hubFor(report, { operationId: 'op-other' }),
      binding: BINDING,
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('missing_evidence');
  });

  it('rejects a fabricated report with no Hub captures even when paths look real', () => {
    const judgement = judgeEvaluation({
      pinned: PINNED,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report: passingReport(),
      hubEvidence: null,
      binding: BINDING,
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('health_only');
  });

  it('rejects screenshot strings whose files were never captured', () => {
    const report = passingReport();
    const judgement = judgeEvaluation({
      pinned: PINNED,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: hubFor(report, { exists: false }),
      binding: BINDING,
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('missing_evidence');
  });

  it('rejects a stale screenshot whose mtime predates this evaluation', () => {
    const report = passingReport();
    const staleMtime = Date.parse('2026-09-14T20:00:00.000Z');
    const judgement = judgeEvaluation({
      pinned: PINNED,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: hubFor(report, { mtimeMs: staleMtime }),
      binding: BINDING,
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('stale_evidence');
  });

  it('rejects a fresh screenshot whose Hub-owned trace mtime is stale', () => {
    const report = passingReport();
    const staleMtime = Date.parse('2026-09-14T20:00:00.000Z');
    const judgement = judgeEvaluation({
      pinned: PINNED,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: stampHubEvidence({
        operationId: BINDING.operationId,
        deploymentId: BINDING.deploymentId,
        expectedSha: SHA,
        observedSha: SHA,
        origin: ORIGIN,
        operationStartedAt: OP_STARTED,
        captures: executionCaptures(report),
        report,
        artifactExists: (filePath) => ({
          exists: true,
          mtimeMs: String(filePath).endsWith('.trace') ? staleMtime : FRESH_MTIME,
          journeyTrace: true,
        }),
      }),
      binding: BINDING,
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('stale_evidence');
  });

  it('rejects a fabricated API 200 that the Hub never recorded', () => {
    const report = passingReport();
    const judgement = judgeEvaluation({
      pinned: PINNED,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: hubFor(report, { omitApi: true }),
      binding: BINDING,
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) {
      expect(judgement.reason).toBe('missing_evidence');
      expect(judgement.detail).toMatch(/without a Hub-recorded request/);
    }
  });

  it('rejects a wrong live revision observed by the Hub', () => {
    const report = passingReport({ observedSha: SHA });
    const judgement = judgeEvaluation({
      pinned: PINNED,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: hubFor(report, { observedSha: 'otherdeadbeef' }),
      binding: BINDING,
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (judgement.ok) return;
    expect(judgement.reason).toBe('wrong_revision');
    expect(shouldRecoverFromEvaluation(judgement)).toBe(true);
  });

  it('rejects health-only false positives', () => {
    const judgement = judge(
      passingReport({
        criteria: [],
        healthCheck: { url: `${ORIGIN}/health`, ok: true },
      }),
    );
    expect(judgement.ok).toBe(false);
    if (judgement.ok) return;
    expect(judgement.reason).toBe('health_only');
    expect(shouldRecoverFromEvaluation(judgement)).toBe(false);
  });

  it('rejects an API check used as evidence for a browser journey', () => {
    const report = passingReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: true,
          kind: 'browser_journey',
          apiCheck: { method: 'GET', url: `${ORIGIN}/health`, status: 200 },
        },
        {
          criterionId: 'baseline-2',
          passed: true,
          kind: 'api_check',
          apiCheck: { method: 'GET', url: `${ORIGIN}/api/todos`, status: 200, bodyExcerpt: '[]' },
        },
      ],
    });
    const judgement = judge(report);
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('missing_evidence');
  });

  it('lets independently recorded API requests share an endpoint across baseline and cycle', () => {
    const pinned = pinCriteriaFromSpec(
      SPEC,
      1,
      deriveCycleJourneys(
        SPEC,
        { cardId: 'card-1' },
        { primaryCardId: 'card-1', cards: [{ cardId: 'card-1' }] },
      ),
    );
    expect(pinned.criteria.map((c) => c.id)).toEqual([
      'baseline-1',
      'baseline-2',
      'cycle-1',
      'cycle-2',
    ]);
    expect(pinned.criteria.filter((c) => c.kind === 'api_check').map((c) => c.id)).toEqual([
      'baseline-2',
      'cycle-2',
    ]);
    const report = passingReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: true,
          kind: 'browser_journey',
          screenshotPath: '/tmp/eval/todo.png',
          tracePath: '/tmp/eval/todo.trace',
        },
        {
          criterionId: 'baseline-2',
          passed: true,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: `${ORIGIN}/api/todos`,
            status: 200,
            bodyExcerpt: '[{"title":"x"}]',
          },
        },
        {
          criterionId: 'cycle-1',
          passed: true,
          kind: 'browser_journey',
          screenshotPath: '/tmp/eval/cycle.png',
          tracePath: '/tmp/eval/cycle.trace',
        },
        {
          criterionId: 'cycle-2',
          passed: true,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: `${ORIGIN}/api/todos`,
            status: 200,
            bodyExcerpt: '[{"title":"x"}]',
          },
        },
      ],
    });
    const captures: AutopilotExecutionCapture[] = [
      {
        captureId: 'cap-b1',
        criterionId: 'baseline-1',
        kind: 'browser_journey',
        capturedAt: '2026-09-14T21:59:00.000Z',
        operationId: BINDING.operationId,
        deploymentId: BINDING.deploymentId,
        expectedSha: SHA,
        origin: ORIGIN,
        screenshot: { path: '/tmp/eval/todo.png', mtimeMs: FRESH_MTIME },
        trace: { path: '/tmp/eval/todo.trace', mtimeMs: FRESH_MTIME },
        api: null,
      },
      {
        captureId: 'cap-a1',
        criterionId: 'baseline-2',
        kind: 'api_check',
        capturedAt: '2026-09-14T21:59:00.000Z',
        operationId: BINDING.operationId,
        deploymentId: BINDING.deploymentId,
        expectedSha: SHA,
        origin: ORIGIN,
        screenshot: null,
        trace: null,
        api: {
          requestId: 'req-baseline-2',
          method: 'GET',
          url: `${ORIGIN}/api/todos`,
          status: 200,
          bodyExcerpt: '[{"title":"x"}]',
        },
      },
      {
        captureId: 'cap-c1',
        criterionId: 'cycle-1',
        kind: 'browser_journey',
        capturedAt: '2026-09-14T21:59:00.000Z',
        operationId: BINDING.operationId,
        deploymentId: BINDING.deploymentId,
        expectedSha: SHA,
        origin: ORIGIN,
        screenshot: { path: '/tmp/eval/cycle.png', mtimeMs: FRESH_MTIME },
        trace: { path: '/tmp/eval/cycle.trace', mtimeMs: FRESH_MTIME },
        api: null,
      },
      {
        captureId: 'cap-a2',
        criterionId: 'cycle-2',
        kind: 'api_check',
        capturedAt: '2026-09-14T21:59:00.000Z',
        operationId: BINDING.operationId,
        deploymentId: BINDING.deploymentId,
        expectedSha: SHA,
        origin: ORIGIN,
        screenshot: null,
        trace: null,
        api: {
          requestId: 'req-cycle-2',
          method: 'GET',
          url: `${ORIGIN}/api/todos`,
          status: 200,
          bodyExcerpt: '[{"title":"x"}]',
        },
      },
    ];
    const judgement = judgeEvaluation({
      pinned,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: hubFor(report, { captures }),
      binding: BINDING,
      now: NOW,
    });
    expect(judgement).toEqual({ ok: true, sha: SHA });
  });

  it('rejects a browser journey whose Hub capture has a screenshot but no trace', () => {
    const report = passingReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: true,
          kind: 'browser_journey',
          screenshotPath: '/tmp/eval/todo.png',
        },
        {
          criterionId: 'baseline-2',
          passed: true,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: `${ORIGIN}/api/todos`,
            status: 200,
            bodyExcerpt: '[{"title":"x"}]',
          },
        },
      ],
    });
    const judgement = judge(report);
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) {
      expect(judgement.reason).toBe('missing_evidence');
      expect(judgement.detail).toMatch(/screenshot and trace/);
    }
  });

  it('rejects a final-page snapshot as browser trace evidence', () => {
    const report = passingReport();
    const judgement = judgeEvaluation({
      pinned: PINNED,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: stampHubEvidence({
        operationId: BINDING.operationId,
        deploymentId: BINDING.deploymentId,
        expectedSha: SHA,
        observedSha: SHA,
        origin: ORIGIN,
        operationStartedAt: OP_STARTED,
        captures: executionCaptures(report),
        report,
        artifactExists: (filePath) => ({
          exists: true,
          mtimeMs: FRESH_MTIME,
          journeyTrace: !String(filePath).endsWith('.trace'),
        }),
      }),
      binding: BINDING,
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) {
      expect(judgement.reason).toBe('missing_evidence');
      expect(judgement.detail).toMatch(/screenshot and trace/);
    }
  });

  it('rejects a 200 API response whose body does not satisfy the expected result', () => {
    const report = passingReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: true,
          kind: 'browser_journey',
          screenshotPath: '/tmp/eval/todo.png',
          tracePath: '/tmp/eval/todo.trace',
        },
        {
          criterionId: 'baseline-2',
          passed: true,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: `${ORIGIN}/api/todos`,
            status: 200,
            bodyExcerpt: '[]',
          },
        },
      ],
    });
    const judgement = judge(report);
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) {
      expect(judgement.reason).toBe('baseline_regression');
      expect(judgement.detail).toMatch(/did not match expected result/);
    }
  });

  it('rejects an explicit API baseline failure even when Hub recorded 200 with items', () => {
    const report = passingReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: true,
          kind: 'browser_journey',
          screenshotPath: '/tmp/eval/todo.png',
          tracePath: '/tmp/eval/todo.trace',
        },
        {
          criterionId: 'baseline-2',
          passed: false,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: `${ORIGIN}/api/todos`,
            status: 200,
            bodyExcerpt: '[{"title":"x"}]',
          },
          observed: 'list was empty',
        },
      ],
    });
    const judgement = judge(report);
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) {
      expect(judgement.reason).toBe('baseline_regression');
      expect(shouldRecoverFromEvaluation(judgement)).toBe(true);
    }
  });

  function judgeApiExpected(expectedResult: string, body: string) {
    const spec: AutopilotEvaluationSpec = {
      acceptanceJourneys: [{ action: 'GET /api/todos', expectedResult }],
      qualityRubricVersion: 1,
    };
    const pinned = pinCriteriaFromSpec(spec, 1);
    const report = passingReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: true,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: `${ORIGIN}/api/todos`,
            status: 200,
            bodyExcerpt: body,
          },
        },
      ],
    });
    return judgeEvaluation({
      pinned,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: hubFor(report),
      binding: BINDING,
      now: NOW,
    });
  }

  it('rejects a Hub body whose field value contradicts the pinned assertion', () => {
    const spec: AutopilotEvaluationSpec = {
      acceptanceJourneys: [
        { action: 'GET /api/health', expectedResult: 'returns JSON with ready true' },
      ],
      qualityRubricVersion: 1,
    };
    const pinned = pinCriteriaFromSpec(spec, 1);
    const report = passingReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: true,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: `${ORIGIN}/api/health`,
            status: 200,
            bodyExcerpt: '{"ready":false}',
          },
        },
      ],
    });
    const judgement = judgeEvaluation({
      pinned,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: hubFor(report),
      binding: BINDING,
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('baseline_regression');
  });

  it('rejects unrelated collection contents that are not stored todo items', () => {
    const judgement = judgeApiExpected(
      'returns the stored items as JSON',
      '[{"error":"database unavailable"}]',
    );
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('baseline_regression');
  });

  it('accepts an empty JSON list when that is the pinned expected result', () => {
    const judgement = judgeApiExpected('returns an empty JSON list', '[]');
    expect(judgement).toEqual({ ok: true, sha: SHA });
  });

  it('evaluates pinned assertions against a complete body longer than the display excerpt', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      title: `stored-todo-${String(i).padStart(2, '0')}-xxxxxxxxxxxxxxxx`,
    }));
    const body = JSON.stringify(items);
    expect(body.length).toBeGreaterThan(AUTOPILOT_API_BODY_EXCERPT_CHARS);
    const excerpt = body.slice(0, AUTOPILOT_API_BODY_EXCERPT_CHARS);
    expect(() => JSON.parse(excerpt)).toThrow();

    const spec: AutopilotEvaluationSpec = {
      acceptanceJourneys: [
        { action: 'GET /api/todos', expectedResult: 'returns the stored items as JSON' },
      ],
      qualityRubricVersion: 1,
    };
    const pinned = pinCriteriaFromSpec(spec, 1);
    const criterion = pinned.criteria[0]!;
    expect(
      apiSatisfiesExpectedResult(criterion, {
        method: 'GET',
        url: `${ORIGIN}/api/todos`,
        status: 200,
        body,
        bodyComplete: true,
        bodyExcerpt: excerpt,
      }),
    ).toBe(true);
    expect(
      apiSatisfiesExpectedResult(criterion, {
        method: 'GET',
        url: `${ORIGIN}/api/todos`,
        status: 200,
        bodyExcerpt: excerpt,
      }),
    ).toBe(false);

    const report = passingReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: true,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: `${ORIGIN}/api/todos`,
            status: 200,
            body,
            bodyComplete: true,
            bodyExcerpt: excerpt,
          },
        },
      ],
    });
    const stamped = hubFor(report);
    expect(stamped.captures[0]?.apiCheck?.body).toBe(body);
    expect(stamped.captures[0]?.apiCheck?.bodyExcerpt).toBe(excerpt);
    const roundTripped = parseHubEvidence(JSON.parse(JSON.stringify(stamped)));
    expect(roundTripped?.captures[0]?.apiCheck?.body).toBe(body);
    expect(
      judgeEvaluation({
        pinned,
        expectedSha: SHA,
        targetOrigin: ORIGIN,
        report,
        hubEvidence: stamped,
        binding: BINDING,
        now: NOW,
      }),
    ).toEqual({ ok: true, sha: SHA });
    expect(
      judgeEvaluation({
        pinned,
        expectedSha: SHA,
        targetOrigin: ORIGIN,
        report,
        hubEvidence: roundTripped,
        binding: BINDING,
        now: NOW,
      }),
    ).toEqual({ ok: true, sha: SHA });
  });

  it('refuses JSON assertions when the recorded body was cut at the size bound', () => {
    const text = `[${'"x",'.repeat(20)}${'y'.repeat(AUTOPILOT_API_BODY_MAX_CHARS)}]`;
    const bounded = boundApiResponseBody(text);
    expect(bounded.bodyComplete).toBe(false);
    expect(bounded.body).toHaveLength(AUTOPILOT_API_BODY_MAX_CHARS);
    expect(bounded.bodyExcerpt).toHaveLength(AUTOPILOT_API_BODY_EXCERPT_CHARS);
    const spec: AutopilotEvaluationSpec = {
      acceptanceJourneys: [
        { action: 'GET /api/todos', expectedResult: 'returns the stored items as JSON' },
      ],
      qualityRubricVersion: 1,
    };
    const criterion = pinCriteriaFromSpec(spec, 1).criteria[0]!;
    expect(
      apiSatisfiesExpectedResult(criterion, {
        method: 'GET',
        url: `${ORIGIN}/api/todos`,
        status: 200,
        ...bounded,
      }),
    ).toBe(false);
  });

  it('rejects a nonempty list when the pinned expectation is empty', () => {
    const judgement = judgeApiExpected('returns an empty JSON list', '[{"title":"x"}]');
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('baseline_regression');
  });

  it('rejects a baseline regression with recovery, not improvement selection', () => {
    const judgement = judge(
      passingReport({
        criteria: [
          {
            criterionId: 'baseline-1',
            passed: false,
            kind: 'browser_journey',
            screenshotPath: '/tmp/eval/fail.png',
            tracePath: '/tmp/eval/fail.trace',
            observed: 'list stayed empty',
          },
          {
            criterionId: 'baseline-2',
            passed: true,
            kind: 'api_check',
            apiCheck: { method: 'GET', url: `${ORIGIN}/api/todos`, status: 200, bodyExcerpt: '[]' },
          },
        ],
      }),
    );
    expect(judgement.ok).toBe(false);
    if (judgement.ok) return;
    expect(judgement.reason).toBe('baseline_regression');
    expect(shouldRecoverFromEvaluation(judgement)).toBe(true);
  });

  it('rejects unverifiable subjective claims and stale or missing artifacts', () => {
    const subjective = judge(
      passingReport({
        criteria: [
          {
            criterionId: 'baseline-1',
            passed: true,
            kind: 'browser_journey',
            claimedWithoutEvidence: true,
            observed: 'looks good',
          },
          {
            criterionId: 'baseline-2',
            passed: true,
            kind: 'api_check',
            apiCheck: { method: 'GET', url: `${ORIGIN}/api/todos`, status: 200, bodyExcerpt: '[]' },
          },
        ],
      }),
    );
    expect(subjective.ok).toBe(false);
    if (!subjective.ok) expect(subjective.reason).toBe('unverifiable_claim');

    const report = passingReport();
    const staleHub = hubFor(report);
    staleHub.binding.operationStartedAt = '2026-09-14T20:00:00.000Z';
    for (const cap of staleHub.captures) {
      cap.capturedAt = '2026-09-14T20:00:00.000Z';
      cap.screenshotMtimeMs = Date.parse('2026-09-14T20:00:00.000Z');
    }
    const stale = judgeEvaluation({
      pinned: PINNED,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report,
      hubEvidence: staleHub,
      binding: BINDING,
      now: NOW,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('stale_evidence');

    const preview = judge(passingReport({ usedPreview: true }));
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.reason).toBe('preview_is_not_deployment');
  });

  it('refuses to judge when criteria were never pinned', () => {
    const judgement = judgeEvaluation({
      pinned: null,
      expectedSha: SHA,
      targetOrigin: ORIGIN,
      report: passingReport(),
      now: NOW,
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('pinned_criteria_missing');
  });
});

describe('writeCycleVerification', () => {
  it('preserves pinned criteria when recording evidence', () => {
    const pinned: AutopilotPinnedCriteria = PINNED;
    const first = JSON.parse(writeCycleVerification(null, { pinned }));
    expect(first.pinned.criteria).toHaveLength(2);
    const second = JSON.parse(
      writeCycleVerification(first, {
        evidence: passingReport(),
        judgement: { ok: true, sha: SHA },
      }),
    );
    expect(second.pinned.specRevision).toBe(1);
    expect(second.judgement).toEqual({ ok: true, sha: SHA });
  });
});

describe('verificationAllowsLastKnownGood', () => {
  const hub: AutopilotHubEvidence = {
    binding: {
      operationId: BINDING.operationId,
      deploymentId: BINDING.deploymentId,
      expectedSha: SHA,
      observedSha: SHA,
      origin: ORIGIN,
      operationStartedAt: OP_STARTED,
    },
    captures: [
      {
        captureId: 'cap-1',
        criterionId: 'baseline-1',
        kind: 'browser_journey',
        capturedAt: '2026-09-14T21:59:00.000Z',
        screenshotPath: '/tmp/eval/todo.png',
        screenshotPresent: true,
        screenshotMtimeMs: FRESH_MTIME,
        tracePresent: false,
        apiOriginMatches: false,
      },
    ],
  };

  it('rejects pending or failed evaluation', () => {
    expect(
      verificationAllowsLastKnownGood(null, { sha: SHA, deploymentId: BINDING.deploymentId }),
    ).toBe(false);
    const failed = JSON.parse(
      writeCycleVerification(null, {
        judgement: { ok: false, reason: 'health_only', detail: 'health only', recover: false },
        hubEvidence: hub,
      }),
    );
    expect(
      verificationAllowsLastKnownGood(failed, { sha: SHA, deploymentId: BINDING.deploymentId }),
    ).toBe(false);
  });

  it('requires the passing judgement SHA and Hub deployment binding', () => {
    const passing = JSON.parse(
      writeCycleVerification(null, {
        judgement: { ok: true, sha: SHA },
        hubEvidence: hub,
      }),
    );
    expect(
      verificationAllowsLastKnownGood(passing, { sha: SHA, deploymentId: BINDING.deploymentId }),
    ).toBe(true);
    expect(verificationAllowsLastKnownGood(passing, { sha: SHA, deploymentId: 'dep-other' })).toBe(
      false,
    );
    expect(
      verificationAllowsLastKnownGood(passing, {
        sha: 'othercafe',
        deploymentId: BINDING.deploymentId,
      }),
    ).toBe(false);
  });
});
