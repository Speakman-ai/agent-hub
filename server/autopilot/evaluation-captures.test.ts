import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  apiTargetFromCriterion,
  appendEvaluationCapture,
  appendEvaluatorBrowserAction,
  AUTOPILOT_EVAL_BROWSER_TRACE_KIND,
  listEvaluationCaptures,
  methodAfterRedirect,
  applyRedirectToRequest,
  probePinnedApiCriterion,
  recordEvaluatorBrowserCapture,
  formatAutopilotCaptureCitation,
} from './evaluation-captures.js';
import {
  apiSatisfiesExpectedResult,
  AUTOPILOT_API_BODY_EXCERPT_CHARS,
  boundApiResponseBody,
  bindExecutionCapture,
  isEvaluatorJourneyTrace,
  judgeEvaluation,
  pinCriteriaFromSpec,
  stampHubEvidence,
  type AutopilotPinnedCriterion,
} from './evaluate.js';

const ORIGIN = 'http://127.0.0.1:4310';

function journeyActions(at = '2026-09-14T21:58:00.000Z') {
  return [
    { op: 'navigate', url: `${ORIGIN}/`, at, ok: true },
    { op: 'type', target: 'New todo', at, ok: true },
    { op: 'click', target: 'Add', at, ok: true },
  ];
}

const EVALUATOR_BINDING = {
  projectId: 'demo',
  runId: 'run-1',
  role: 'evaluator' as const,
  origin: ORIGIN,
};

describe('evaluation captures', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'autopilot-eval-cap-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips a Hub-recorded capture and ignores unbound rows', () => {
    const shot = path.join(dataDir, 'shot.png');
    writeFileSync(shot, 'png');
    const bound = bindExecutionCapture({
      captureId: 'cap-1',
      criterionId: 'baseline-1',
      kind: 'browser_journey',
      capturedAt: '2026-09-14T21:59:00.000Z',
      operationId: 'op-1',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      origin: ORIGIN,
      screenshot: { path: shot, mtimeMs: Date.now() },
      trace: null,
      api: null,
    });
    expect(bound).not.toBeNull();
    expect(appendEvaluationCapture(dataDir, bound!)).not.toBeNull();
    expect(listEvaluationCaptures(dataDir, 'op-1')).toHaveLength(1);
    expect(listEvaluationCaptures(dataDir, 'op-other')).toEqual([]);
  });

  it('records an evaluator screenshot with file mtime', () => {
    const shot = path.join(dataDir, 'shot.png');
    writeFileSync(shot, 'png');
    const recorded = recordEvaluatorBrowserCapture({
      dataDir,
      binding: EVALUATOR_BINDING,
      operationId: 'op-1',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      screenshotPath: shot,
      criterionId: 'baseline-1',
      actions: journeyActions(),
    });
    expect(recorded?.screenshot?.mtimeMs).toBeTypeOf('number');
    expect(listEvaluationCaptures(dataDir, 'op-1')[0]?.screenshot?.path).toBe(shot);
    expect(recorded?.trace?.path).toMatch(/op-1\..+\.trace\.json$/);
  });

  it('persists a Hub-owned trace bound to the evaluation operation and deployment', () => {
    const shot = path.join(dataDir, 'shot.png');
    writeFileSync(shot, 'png');
    const capturedAt = '2026-09-14T21:59:00.000Z';
    const recorded = recordEvaluatorBrowserCapture({
      dataDir,
      binding: {
        projectId: 'demo',
        runId: 'run-1',
        role: 'evaluator',
        origin: `${ORIGIN}/`,
      },
      operationId: 'op-trace',
      deploymentId: 'dep-trace',
      expectedSha: 'deadbeefcafe',
      screenshotPath: shot,
      criterionId: 'baseline-1',
      capturedAt,
      page: {
        url: `${ORIGIN}/todos`,
        title: 'Todos',
        textExcerpt: 'Buy milk',
      },
      actions: journeyActions(capturedAt),
    });
    expect(recorded).not.toBeNull();
    expect(recorded?.operationId).toBe('op-trace');
    expect(recorded?.deploymentId).toBe('dep-trace');
    expect(recorded?.expectedSha).toBe('deadbeefcafe');
    expect(recorded?.origin).toBe(ORIGIN);
    expect(recorded?.screenshot?.path).toBe(shot);
    expect(recorded?.trace?.path).toBeTruthy();
    expect(recorded?.trace?.mtimeMs).toBeTypeOf('number');

    const listed = listEvaluationCaptures(dataDir, 'op-trace');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.trace?.path).toBe(recorded?.trace?.path);

    const body = JSON.parse(readFileSync(recorded!.trace!.path, 'utf8')) as {
      kind: string;
      operationId: string;
      deploymentId: string;
      expectedSha: string;
      origin: string;
      capturedAt: string;
      screenshotPath: string | null;
      page: { url: string; title: string; textExcerpt: string };
      actions: { op: string; at: string; ok: boolean; url?: string; target?: string }[];
    };
    expect(body.kind).toBe(AUTOPILOT_EVAL_BROWSER_TRACE_KIND);
    expect(body.operationId).toBe('op-trace');
    expect(body.deploymentId).toBe('dep-trace');
    expect(body.expectedSha).toBe('deadbeefcafe');
    expect(body.origin).toBe(ORIGIN);
    expect(body.capturedAt).toBe(capturedAt);
    expect(body.screenshotPath).toBe(shot);
    expect(body.page).toEqual({
      url: `${ORIGIN}/todos`,
      title: 'Todos',
      textExcerpt: 'Buy milk',
    });
    expect(body.actions).toEqual(journeyActions(capturedAt));
    expect(isEvaluatorJourneyTrace(body)).toBe(true);

    const stamped = stampHubEvidence({
      operationId: 'op-trace',
      deploymentId: 'dep-trace',
      expectedSha: 'deadbeefcafe',
      observedSha: 'deadbeefcafe',
      origin: ORIGIN,
      operationStartedAt: '2026-09-14T21:50:00.000Z',
      captures: [recorded!],
      artifactExists: (filePath) => {
        if (filePath === recorded?.screenshot?.path || filePath === recorded?.trace?.path) {
          return { exists: true, mtimeMs: Date.parse(capturedAt) };
        }
        return { exists: false };
      },
    });
    expect(stamped?.captures[0]?.tracePath).toBe(recorded?.trace?.path);
    expect(stamped?.captures[0]?.tracePresent).toBe(true);
    expect(stamped?.captures[0]?.traceMtimeMs).toBe(Date.parse(capturedAt));

    const judgement = judgeEvaluation({
      pinned: pinCriteriaFromSpec(
        {
          acceptanceJourneys: [
            { action: 'create a todo', expectedResult: 'it appears in the list' },
          ],
          qualityRubricVersion: 1,
        },
        1,
      ),
      expectedSha: 'deadbeefcafe',
      targetOrigin: ORIGIN,
      report: {
        expectedSha: 'deadbeefcafe',
        observedSha: 'deadbeefcafe',
        origin: ORIGIN,
        capturedAt,
        criteria: [
          {
            criterionId: 'baseline-1',
            passed: true,
            kind: 'browser_journey',
            screenshotPath: shot,
            tracePath: recorded!.trace!.path,
            observed: 'Buy milk',
          },
        ],
      },
      hubEvidence: stamped,
      binding: { operationId: 'op-trace', deploymentId: 'dep-trace' },
      now: new Date('2026-09-14T22:00:00.000Z'),
    });
    expect(judgement).toEqual({ ok: true, sha: 'deadbeefcafe' });
  });

  it('rejects a Hub-owned trace whose mtime predates this evaluation', () => {
    const shot = path.join(dataDir, 'shot.png');
    writeFileSync(shot, 'png');
    const recorded = recordEvaluatorBrowserCapture({
      dataDir,
      binding: EVALUATOR_BINDING,
      operationId: 'op-stale-trace',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      screenshotPath: shot,
      criterionId: 'baseline-1',
      capturedAt: '2026-09-14T21:59:00.000Z',
      page: { url: `${ORIGIN}/`, title: 'Todos', textExcerpt: 'list' },
      actions: journeyActions(),
    });
    expect(recorded?.trace?.path).toBeTruthy();
    const staleMtime = Date.parse('2026-09-14T20:00:00.000Z');
    const stamped = stampHubEvidence({
      operationId: 'op-stale-trace',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      observedSha: 'deadbeefcafe',
      origin: ORIGIN,
      operationStartedAt: '2026-09-14T21:50:00.000Z',
      captures: [recorded!],
      artifactExists: (filePath) => {
        if (filePath === recorded?.trace?.path) return { exists: true, mtimeMs: staleMtime };
        return { exists: true, mtimeMs: recorded!.screenshot!.mtimeMs };
      },
    });
    const judgement = judgeEvaluation({
      pinned: pinCriteriaFromSpec(
        {
          acceptanceJourneys: [
            { action: 'create a todo', expectedResult: 'it appears in the list' },
          ],
          qualityRubricVersion: 1,
        },
        1,
      ),
      expectedSha: 'deadbeefcafe',
      targetOrigin: ORIGIN,
      report: {
        expectedSha: 'deadbeefcafe',
        observedSha: 'deadbeefcafe',
        origin: ORIGIN,
        capturedAt: '2026-09-14T21:59:00.000Z',
        criteria: [
          {
            criterionId: 'baseline-1',
            passed: true,
            kind: 'browser_journey',
            screenshotPath: shot,
            tracePath: recorded!.trace!.path,
          },
        ],
      },
      hubEvidence: stamped,
      binding: { operationId: 'op-stale-trace', deploymentId: 'dep-1' },
      now: new Date('2026-09-14T22:00:00.000Z'),
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) expect(judgement.reason).toBe('stale_evidence');
  });

  it('does not persist a final-page snapshot as a journey trace', () => {
    const shot = path.join(dataDir, 'shot.png');
    writeFileSync(shot, 'png');
    const capturedAt = '2026-09-14T21:59:00.000Z';
    const recorded = recordEvaluatorBrowserCapture({
      dataDir,
      binding: EVALUATOR_BINDING,
      operationId: 'op-snapshot',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      screenshotPath: shot,
      criterionId: 'baseline-1',
      capturedAt,
      page: {
        url: `${ORIGIN}/todos`,
        title: 'Todos',
        textExcerpt: 'Buy milk',
      },
    });
    expect(recorded?.screenshot?.path).toBe(shot);
    expect(recorded?.trace).toBeNull();
  });

  it('persists actions recorded during the journey before the screenshot', () => {
    const shot = path.join(dataDir, 'shot.png');
    writeFileSync(shot, 'png');
    const capturedAt = '2026-09-14T21:59:00.000Z';
    for (const action of journeyActions(capturedAt)) {
      expect(appendEvaluatorBrowserAction(dataDir, 'op-appended', action)).not.toBeNull();
    }
    const recorded = recordEvaluatorBrowserCapture({
      dataDir,
      binding: EVALUATOR_BINDING,
      operationId: 'op-appended',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      screenshotPath: shot,
      criterionId: 'baseline-1',
      capturedAt,
      page: { url: `${ORIGIN}/todos`, title: 'Todos', textExcerpt: 'Buy milk' },
    });
    expect(recorded?.trace?.path).toBeTruthy();
    const body = JSON.parse(readFileSync(recorded!.trace!.path, 'utf8')) as {
      actions: unknown[];
    };
    expect(body.actions).toEqual(journeyActions(capturedAt));
    expect(isEvaluatorJourneyTrace(body)).toBe(true);
  });

  it('rejects a final-page snapshot as trace evidence even when the file exists', () => {
    const shot = path.join(dataDir, 'shot.png');
    writeFileSync(shot, 'png');
    const capturedAt = '2026-09-14T21:59:00.000Z';
    const snapshot = path.join(dataDir, 'page.trace.json');
    writeFileSync(
      snapshot,
      JSON.stringify({
        kind: AUTOPILOT_EVAL_BROWSER_TRACE_KIND,
        operationId: 'op-snap-judge',
        deploymentId: 'dep-1',
        expectedSha: 'deadbeefcafe',
        origin: ORIGIN,
        capturedAt,
        screenshotPath: shot,
        page: {
          url: `${ORIGIN}/todos`,
          title: 'Todos',
          textExcerpt: 'Buy milk',
        },
      }),
    );
    expect(isEvaluatorJourneyTrace(JSON.parse(readFileSync(snapshot, 'utf8')))).toBe(false);

    const ignored = recordEvaluatorBrowserCapture({
      dataDir,
      binding: EVALUATOR_BINDING,
      operationId: 'op-snap-judge',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      screenshotPath: shot,
      tracePath: snapshot,
      criterionId: 'baseline-1',
      capturedAt,
      page: {
        url: `${ORIGIN}/todos`,
        title: 'Todos',
        textExcerpt: 'Buy milk',
      },
    });
    expect(ignored?.trace).toBeNull();

    const bound = bindExecutionCapture({
      captureId: 'cap-snap',
      criterionId: 'baseline-1',
      kind: 'browser_journey',
      capturedAt,
      operationId: 'op-snap-judge',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      origin: ORIGIN,
      screenshot: { path: shot, mtimeMs: Date.parse(capturedAt) },
      trace: { path: snapshot, mtimeMs: Date.parse(capturedAt) },
      api: null,
    });
    expect(bound).not.toBeNull();
    const stamped = stampHubEvidence({
      operationId: 'op-snap-judge',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      observedSha: 'deadbeefcafe',
      origin: ORIGIN,
      operationStartedAt: '2026-09-14T21:50:00.000Z',
      captures: [bound!],
      artifactExists: (filePath) => {
        if (filePath === shot || filePath === snapshot) {
          return { exists: true, mtimeMs: Date.parse(capturedAt) };
        }
        return { exists: false };
      },
    });
    expect(stamped?.captures[0]?.tracePath).toBe(snapshot);
    expect(stamped?.captures[0]?.screenshotPresent).toBe(true);
    expect(stamped?.captures[0]?.tracePresent).toBe(false);

    const judgement = judgeEvaluation({
      pinned: pinCriteriaFromSpec(
        {
          acceptanceJourneys: [
            { action: 'create a todo', expectedResult: 'it appears in the list' },
          ],
          qualityRubricVersion: 1,
        },
        1,
      ),
      expectedSha: 'deadbeefcafe',
      targetOrigin: ORIGIN,
      report: {
        expectedSha: 'deadbeefcafe',
        observedSha: 'deadbeefcafe',
        origin: ORIGIN,
        capturedAt,
        criteria: [
          {
            criterionId: 'baseline-1',
            passed: true,
            kind: 'browser_journey',
            screenshotPath: shot,
            tracePath: snapshot,
            observed: 'Buy milk',
          },
        ],
      },
      hubEvidence: stamped,
      binding: { operationId: 'op-snap-judge', deploymentId: 'dep-1' },
      now: new Date('2026-09-14T22:00:00.000Z'),
    });
    expect(judgement.ok).toBe(false);
    if (!judgement.ok) {
      expect(judgement.reason).toBe('missing_evidence');
      expect(judgement.detail).toMatch(/screenshot and trace/);
    }
  });

  it('probes a pinned API criterion and records a unique requestId', async () => {
    const criterion: AutopilotPinnedCriterion = {
      id: 'baseline-1',
      source: 'baseline',
      kind: 'api_check',
      action: 'GET /api/todos',
      expectedResult: 'returns JSON',
    };
    expect(apiTargetFromCriterion(ORIGIN, criterion)).toEqual({
      method: 'GET',
      url: `${ORIGIN}/api/todos`,
    });
    const capture = await probePinnedApiCriterion({
      operationId: 'op-1',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      origin: ORIGIN,
      criterion,
      capturedAt: '2026-09-14T21:59:00.000Z',
      fetchImpl: (async () =>
        new Response('[{"title":"x"}]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    expect(capture?.api?.requestId).toBeTruthy();
    expect(capture?.api?.status).toBe(200);
    expect(capture?.api?.url).toBe(`${ORIGIN}/api/todos`);
  });

  it('records a complete API body over 512 characters and truncates only the excerpt', async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      title: `stored-todo-${String(i).padStart(2, '0')}-xxxxxxxxxxxxxxxx`,
    }));
    const body = JSON.stringify(items);
    expect(body.length).toBeGreaterThan(AUTOPILOT_API_BODY_EXCERPT_CHARS);
    const criterion: AutopilotPinnedCriterion = {
      id: 'baseline-1',
      source: 'baseline',
      kind: 'api_check',
      action: 'GET /api/todos',
      expectedResult: 'returns the stored items as JSON',
    };
    const capture = await probePinnedApiCriterion({
      operationId: 'op-1',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      origin: ORIGIN,
      criterion,
      capturedAt: '2026-09-14T21:59:00.000Z',
      fetchImpl: (async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    expect(capture?.api?.body).toBe(body);
    expect(capture?.api?.bodyComplete).toBe(true);
    expect(capture?.api?.bodyExcerpt).toBe(body.slice(0, AUTOPILOT_API_BODY_EXCERPT_CHARS));
    expect(JSON.parse(capture!.api!.body!)).toHaveLength(40);
    expect(() => JSON.parse(capture!.api!.bodyExcerpt!)).toThrow();
    expect(boundApiResponseBody(body).bodyExcerpt).toBe(capture?.api?.bodyExcerpt);

    const stamped = stampHubEvidence({
      operationId: 'op-1',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      observedSha: 'deadbeefcafe',
      origin: ORIGIN,
      operationStartedAt: '2026-09-14T21:50:00.000Z',
      captures: [capture!],
    });
    expect(stamped?.captures[0]?.apiCheck?.body).toBe(body);
    expect(stamped?.captures[0]?.apiCheck?.bodyExcerpt?.length).toBe(
      AUTOPILOT_API_BODY_EXCERPT_CHARS,
    );
    expect(apiSatisfiesExpectedResult(criterion, stamped!.captures[0]!.apiCheck!)).toBe(true);

    const judgement = judgeEvaluation({
      pinned: pinCriteriaFromSpec(
        {
          acceptanceJourneys: [
            { action: 'GET /api/todos', expectedResult: 'returns the stored items as JSON' },
          ],
          qualityRubricVersion: 1,
        },
        1,
      ),
      expectedSha: 'deadbeefcafe',
      targetOrigin: ORIGIN,
      report: {
        expectedSha: 'deadbeefcafe',
        observedSha: 'deadbeefcafe',
        origin: ORIGIN,
        capturedAt: '2026-09-14T21:59:00.000Z',
        criteria: [
          {
            criterionId: 'baseline-1',
            passed: true,
            kind: 'api_check',
            apiCheck: {
              method: 'GET',
              url: `${ORIGIN}/api/todos`,
              status: 200,
              bodyExcerpt: capture!.api!.bodyExcerpt,
            },
          },
        ],
      },
      hubEvidence: stamped,
      binding: { operationId: 'op-1', deploymentId: 'dep-1' },
      now: new Date('2026-09-14T22:00:00.000Z'),
    });
    expect(judgement).toEqual({ ok: true, sha: 'deadbeefcafe' });
  });

  function probeArgs(
    fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    extra: {
      timeoutMs?: number;
      maxBodyChars?: number;
      action?: string;
    } = {},
  ) {
    const { action, ...probeExtra } = extra;
    const criterion: AutopilotPinnedCriterion = {
      id: 'baseline-1',
      source: 'baseline',
      kind: 'api_check',
      action: action ?? 'GET /api/todos',
      expectedResult: 'returns JSON',
    };
    return {
      operationId: 'op-1',
      deploymentId: 'dep-1',
      expectedSha: 'deadbeefcafe',
      origin: ORIGIN,
      criterion,
      capturedAt: '2026-09-14T21:59:00.000Z',
      fetchImpl,
      ...probeExtra,
    };
  }

  it('rejects a cross-origin redirect and does not record the foreign body', async () => {
    const seen: string[] = [];
    const capture = await probePinnedApiCriterion(
      probeArgs(async (url, init) => {
        seen.push(String(url));
        expect(init?.redirect).toBe('manual');
        return new Response('[{"title":"foreign"}]', {
          status: 302,
          headers: { Location: 'https://evil.example/api/todos' },
        });
      }),
    );
    expect(capture).toBeNull();
    expect(seen).toEqual([`${ORIGIN}/api/todos`]);
  });

  it('rejects a 200 whose response URL left the pinned origin', async () => {
    const capture = await probePinnedApiCriterion(
      probeArgs(async () => {
        const res = new Response('[{"title":"x"}]', { status: 200 });
        Object.defineProperty(res, 'url', { value: 'https://evil.example/api/todos' });
        return res;
      }),
    );
    expect(capture).toBeNull();
  });

  it('follows a same-origin redirect and records the actual response URL', async () => {
    const seen: string[] = [];
    const capture = await probePinnedApiCriterion(
      probeArgs(async (url) => {
        const href = String(url);
        seen.push(href);
        if (href === `${ORIGIN}/api/todos`) {
          return new Response(null, {
            status: 302,
            headers: { Location: '/api/todos/' },
          });
        }
        return new Response('[{"title":"x"}]', { status: 200 });
      }),
    );
    expect(seen).toEqual([`${ORIGIN}/api/todos`, `${ORIGIN}/api/todos/`]);
    expect(capture?.api?.url).toBe(`${ORIGIN}/api/todos/`);
    expect(capture?.api?.status).toBe(200);
    expect(capture?.api?.body).toBe('[{"title":"x"}]');
  });

  it('cancels an oversized response stream at the size bound', async () => {
    let cancelled = false;
    let enqueued = 0;
    const maxBodyChars = 256;
    const capture = await probePinnedApiCriterion(
      probeArgs(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array(128).fill(0x61));
                enqueued += 128;
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
        { maxBodyChars, timeoutMs: 1_000 },
      ),
    );
    expect(cancelled).toBe(true);
    expect(enqueued).toBeLessThan(maxBodyChars * 8);
    expect(capture?.api?.bodyComplete).toBe(false);
    expect(capture?.api?.body).toHaveLength(maxBodyChars);
  });

  it('aborts when response headers never arrive', async () => {
    const started = Date.now();
    const capture = await probePinnedApiCriterion(
      probeArgs(() => new Promise<Response>(() => undefined), {
        timeoutMs: 40,
      }),
    );
    expect(capture).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('aborts a response whose body never ends', async () => {
    const started = Date.now();
    const capture = await probePinnedApiCriterion(
      probeArgs(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                /* never enqueue or close */
              },
            }),
          ),
        { timeoutMs: 40 },
      ),
    );
    expect(capture).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  function hangingCancelStream(
    onPull: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  ) {
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        onPull(controller);
      },
      cancel() {
        return new Promise(() => undefined);
      },
    });
  }

  it('finishes overflow without waiting for a hanging stream cancel', async () => {
    const started = Date.now();
    const maxBodyChars = 256;
    const capture = await probePinnedApiCriterion(
      probeArgs(
        async () =>
          new Response(
            hangingCancelStream((controller) => {
              controller.enqueue(new Uint8Array(128).fill(0x61));
            }),
          ),
        { maxBodyChars, timeoutMs: 2_000 },
      ),
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(capture?.api?.bodyComplete).toBe(false);
    expect(capture?.api?.body).toHaveLength(maxBodyChars);
  });

  it('rejects a redirect without waiting for a hanging stream cancel', async () => {
    const started = Date.now();
    const seen: string[] = [];
    const capture = await probePinnedApiCriterion(
      probeArgs(
        async (url) => {
          seen.push(String(url));
          return new Response(
            hangingCancelStream(() => undefined),
            {
              status: 302,
              headers: { Location: 'https://evil.example/api/todos' },
            },
          );
        },
        { timeoutMs: 2_000 },
      ),
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(capture).toBeNull();
    expect(seen).toEqual([`${ORIGIN}/api/todos`]);
  });

  describe('Fetch redirect method rewrite', () => {
    it('matches HTTP-redirect fetch step 12', () => {
      const cases: [status: number, method: string, next: string][] = [
        [301, 'POST', 'GET'],
        [302, 'POST', 'GET'],
        [301, 'DELETE', 'DELETE'],
        [302, 'PUT', 'PUT'],
        [301, 'PATCH', 'PATCH'],
        [301, 'HEAD', 'HEAD'],
        [301, 'GET', 'GET'],
        [303, 'DELETE', 'GET'],
        [303, 'POST', 'GET'],
        [303, 'PUT', 'GET'],
        [303, 'PATCH', 'GET'],
        [303, 'HEAD', 'HEAD'],
        [303, 'GET', 'GET'],
        [307, 'POST', 'POST'],
        [307, 'DELETE', 'DELETE'],
        [308, 'POST', 'POST'],
        [308, 'DELETE', 'DELETE'],
      ];
      for (const [status, method, next] of cases) {
        expect(methodAfterRedirect(status, method), `${status} ${method}`).toBe(next);
      }
    });

    it('strips body and request-body headers when a redirect rewrites the method', () => {
      expect(
        applyRedirectToRequest(302, {
          method: 'POST',
          body: '{"title":"x"}',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
        }),
      ).toEqual({ method: 'GET', headers: { accept: 'application/json' } });
      expect(
        applyRedirectToRequest(307, {
          method: 'PUT',
          body: '{"title":"x"}',
          headers: { 'content-type': 'application/json' },
        }),
      ).toEqual({
        method: 'PUT',
        body: '{"title":"x"}',
        headers: { 'content-type': 'application/json' },
      });
    });

    async function hopsFor(action: string, status: number) {
      const hops: { url: string; method: string; body?: string; contentType?: string }[] = [];
      const capture = await probePinnedApiCriterion(
        probeArgs(
          async (url, init) => {
            const headers = init?.headers as Record<string, string> | undefined;
            hops.push({
              url: String(url),
              method: String(init?.method ?? 'GET'),
              ...(init?.body != null ? { body: String(init.body) } : {}),
              ...(headers?.['content-type'] ? { contentType: headers['content-type'] } : {}),
            });
            if (hops.length === 1) {
              return new Response(null, {
                status,
                headers: { Location: '/api/todos/next' },
              });
            }
            return new Response('{"ok":true}', { status: 200 });
          },
          { action },
        ),
      );
      return { hops, method: capture?.api?.method };
    }

    it('keeps DELETE across a same-origin 301', async () => {
      const { hops, method } = await hopsFor('DELETE /api/todos', 301);
      expect(hops).toEqual([
        { url: `${ORIGIN}/api/todos`, method: 'DELETE' },
        { url: `${ORIGIN}/api/todos/next`, method: 'DELETE' },
      ]);
      expect(method).toBe('DELETE');
    });

    it('rewrites POST to GET on a 302 and records the GET', async () => {
      const { hops, method } = await hopsFor('POST /api/todos', 302);
      expect(hops).toEqual([
        { url: `${ORIGIN}/api/todos`, method: 'POST' },
        { url: `${ORIGIN}/api/todos/next`, method: 'GET' },
      ]);
      expect(method).toBe('GET');
    });

    it('sends a pinned POST JSON body and drops it when 302 rewrites to GET', async () => {
      const { hops, method } = await hopsFor('POST /api/todos {"title":"Buy milk"}', 302);
      expect(hops).toEqual([
        {
          url: `${ORIGIN}/api/todos`,
          method: 'POST',
          body: '{"title":"Buy milk"}',
          contentType: 'application/json',
        },
        { url: `${ORIGIN}/api/todos/next`, method: 'GET' },
      ]);
      expect(method).toBe('GET');
    });

    it('keeps a PUT JSON body across a 307', async () => {
      const { hops, method } = await hopsFor('PUT /api/todos {"title":"x"}', 307);
      expect(hops).toEqual([
        {
          url: `${ORIGIN}/api/todos`,
          method: 'PUT',
          body: '{"title":"x"}',
          contentType: 'application/json',
        },
        {
          url: `${ORIGIN}/api/todos/next`,
          method: 'PUT',
          body: '{"title":"x"}',
          contentType: 'application/json',
        },
      ]);
      expect(method).toBe('PUT');
    });

    it('rewrites PUT to GET on a 303 but keeps HEAD', async () => {
      const put = await hopsFor('PUT /api/todos', 303);
      expect(put.hops[1]?.method).toBe('GET');
      expect(put.method).toBe('GET');
      const head = await hopsFor('HEAD /api/todos', 303);
      expect(head.hops).toEqual([
        { url: `${ORIGIN}/api/todos`, method: 'HEAD' },
        { url: `${ORIGIN}/api/todos/next`, method: 'HEAD' },
      ]);
      expect(head.method).toBe('HEAD');
    });
  });
});

describe('formatAutopilotCaptureCitation', () => {
  it('includes Hub screenshot and trace paths for the evaluator to cite', () => {
    expect(formatAutopilotCaptureCitation(null)).toBe('');
    expect(
      formatAutopilotCaptureCitation({
        screenshot: { path: '/data/browser-screenshots/s/shot.jpg' },
        trace: { path: '/data/autopilot-eval-captures/op.trace.json' },
      }),
    ).toContain('screenshotPath: /data/browser-screenshots/s/shot.jpg');
  });
});
