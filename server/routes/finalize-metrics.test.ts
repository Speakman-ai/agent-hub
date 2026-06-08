/**
 * Integration tests for `GET /api/projects/:projectId/finalize/metrics`
 * plus a simulated end-to-end Finalize run that asserts every documented
 * metric event lands with the correct labels.
 *
 * The supertest harness drives the live Express app so the routing,
 * the prepared-statement seam, and the aggregation pipeline are
 * exercised exactly as production does it.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { getStmts } from '../db.js';
import {
  METRIC_NAMES,
  recordFixDispatchCount,
  recordMergedPrProvenance,
  recordReviewerVerdict,
  recordRunActiveSeconds,
  recordRunCompleted,
  recordRunStarted,
  recordRunWallSeconds,
  recordStalledNoResponse,
  recordStepResult,
} from '../finalize/metrics.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `metrics-test-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

describe('GET /api/projects/:projectId/finalize/metrics', () => {
  it('404 when the project does not exist', async () => {
    const res = await request.get('/api/projects/no-such-project/finalize/metrics').expect(404);
    expect(res.body.error).toMatch(/project not found/i);
  });

  it('400 when the range query is unparseable', async () => {
    const projectId = await freshProject();
    const res = await request
      .get(`/api/projects/${projectId}/finalize/metrics`)
      .query({ range: 'wat' })
      .expect(400);
    expect(res.body.error).toBe('invalid_range');
    // The message must advertise the actual `..` separator (not `:`) so a
    // caller who hits the 400 and follows the hint doesn't loop on a
    // second 400.
    expect(res.body.message).toContain('..');
    expect(res.body.message).not.toMatch(/:<isoTo>/);
  });

  it('400 when metrics filter contains only unknown names', async () => {
    const projectId = await freshProject();
    const res = await request
      .get(`/api/projects/${projectId}/finalize/metrics`)
      .query({ metrics: 'bogus,also-bogus' })
      .expect(400);
    expect(res.body.error).toBe('invalid_metrics');
  });

  it('returns zero-row aggregates for every known metric on an empty project', async () => {
    const projectId = await freshProject();
    const res = await request
      .get(`/api/projects/${projectId}/finalize/metrics`)
      .query({ range: '1h' })
      .expect(200);
    expect(res.body.project_id).toBe(projectId);
    expect(res.body.sample_count).toBe(0);
    expect(res.body.metrics).toHaveLength(METRIC_NAMES.length);
    for (const m of res.body.metrics) {
      if (m.kind === 'counter') expect(m.count).toBe(0);
      if (m.kind === 'histogram') expect(m.summary.count).toBe(0);
    }
  });

  it('aggregates a mix of counters and histograms with per-label slices', async () => {
    const projectId = await freshProject();
    const stmts = getStmts();
    const deps = { stmts, now: () => Date.now() };
    recordRunStarted(deps, { projectId, runId: 'run-1', triggerSource: 'ui_button' });
    recordRunStarted(deps, { projectId, runId: 'run-2', triggerSource: 'ui_button' });
    recordRunStarted(deps, { projectId, runId: 'run-3', triggerSource: 'agent_block' });
    recordRunActiveSeconds(deps, {
      projectId,
      runId: 'run-1',
      activeSeconds: 100,
      status: 'pushed',
    });
    recordRunActiveSeconds(deps, {
      projectId,
      runId: 'run-2',
      activeSeconds: 200,
      status: 'pushed',
    });

    const res = await request
      .get(`/api/projects/${projectId}/finalize/metrics`)
      .query({ range: '1h' })
      .expect(200);
    const counter = res.body.metrics.find(
      (m: { metric: string }) => m.metric === 'finalize_run_started',
    );
    expect(counter.kind).toBe('counter');
    expect(counter.count).toBe(3);
    const triggerGroups = counter.groups as Array<{
      labels: Record<string, string>;
      count: number;
    }>;
    expect(triggerGroups).toEqual(
      expect.arrayContaining([
        { labels: { trigger_source: 'ui_button' }, count: 2 },
        { labels: { trigger_source: 'agent_block' }, count: 1 },
      ]),
    );
    const hist = res.body.metrics.find(
      (m: { metric: string }) => m.metric === 'finalize_run_active_seconds',
    );
    expect(hist.kind).toBe('histogram');
    expect(hist.summary.count).toBe(2);
    expect(hist.summary.min).toBe(100);
    expect(hist.summary.max).toBe(200);
    expect(hist.summary.avg).toBeCloseTo(150);
  });

  it('respects the `metrics` filter and ignores unknown names beside known ones', async () => {
    const projectId = await freshProject();
    const stmts = getStmts();
    const deps = { stmts, now: () => Date.now() };
    recordStalledNoResponse(deps, { projectId, runId: 'r1' });
    const res = await request
      .get(`/api/projects/${projectId}/finalize/metrics`)
      .query({ metrics: 'finalize_stalled_no_response_count,wat' })
      .expect(200);
    expect(res.body.metrics).toHaveLength(1);
    expect(res.body.metrics[0].metric).toBe('finalize_stalled_no_response_count');
    expect(res.body.metrics[0].count).toBe(1);
  });

  it('scopes by project_id and excludes other projects rows', async () => {
    const projectA = await freshProject();
    const projectB = await freshProject();
    const stmts = getStmts();
    const deps = { stmts, now: () => Date.now() };
    recordRunStarted(deps, { projectId: projectA, runId: 'a1', triggerSource: 'ui_button' });
    recordRunStarted(deps, { projectId: projectB, runId: 'b1', triggerSource: 'ui_button' });
    const res = await request.get(`/api/projects/${projectA}/finalize/metrics`).expect(200);
    const counter = res.body.metrics.find(
      (m: { metric: string }) => m.metric === 'finalize_run_started',
    );
    expect(counter.count).toBe(1);
  });

  it('excludes rows older than the requested window', async () => {
    const projectId = await freshProject();
    const stmts = getStmts();
    // Past row outside the window — observed 2 hours ago.
    recordRunStarted(
      { stmts, now: () => Date.now() - 2 * 60 * 60 * 1000 },
      { projectId, runId: 'old', triggerSource: 'ui_button' },
    );
    // Fresh row inside the window.
    recordRunStarted(
      { stmts, now: () => Date.now() },
      { projectId, runId: 'new', triggerSource: 'ui_button' },
    );
    const res = await request
      .get(`/api/projects/${projectId}/finalize/metrics`)
      .query({ range: '1h' })
      .expect(200);
    const counter = res.body.metrics.find(
      (m: { metric: string }) => m.metric === 'finalize_run_started',
    );
    expect(counter.count).toBe(1);
  });
});

describe('simulated full Finalize run end-to-end metric coverage', () => {
  it('every documented metric lands with the documented labels', async () => {
    const projectId = await freshProject();
    const stmts = getStmts();
    const deps = { stmts, now: () => Date.now() };
    const runId = `run-${uuidv4().slice(0, 8)}`;

    // 1. Run kicks off via UI.
    recordRunStarted(deps, { projectId, runId, triggerSource: 'ui_button' });

    // 2. Reviewer fires changes_requested on iteration 1.
    recordReviewerVerdict(deps, {
      projectId,
      runId,
      verdict: 'changes_requested',
      attemptIndex: 1,
    });

    // 3. Tasks phase runs 3 steps: lint passes, tests fail, deploy skipped.
    recordStepResult(deps, {
      projectId,
      runId,
      stepName: 'lint',
      status: 'passed',
      exitCode: 0,
    });
    recordStepResult(deps, {
      projectId,
      runId,
      stepName: 'tests',
      status: 'failed',
      exitCode: 1,
    });

    // 4. Fix dispatch fires; orchestrator loops.
    // (no per-dispatch metric; aggregate count is sealed at completion)

    // 5. Reviewer approves on iteration 2.
    recordReviewerVerdict(deps, {
      projectId,
      runId,
      verdict: 'approved',
      attemptIndex: 2,
    });
    recordStepResult(deps, {
      projectId,
      runId,
      stepName: 'lint',
      status: 'passed',
      exitCode: 0,
    });
    recordStepResult(deps, {
      projectId,
      runId,
      stepName: 'tests',
      status: 'passed',
      exitCode: 0,
    });

    // 6. Run pushed.
    recordRunCompleted(deps, {
      projectId,
      runId,
      status: 'pushed',
      triggerSource: 'ui_button',
    });
    recordRunActiveSeconds(deps, {
      projectId,
      runId,
      activeSeconds: 1234,
      status: 'pushed',
    });
    recordRunWallSeconds(deps, {
      projectId,
      runId,
      wallSeconds: 1800,
      status: 'pushed',
    });
    recordFixDispatchCount(deps, {
      projectId,
      runId,
      count: 1,
      status: 'pushed',
    });

    // 7. Webhook later observes the PR merge.
    recordMergedPrProvenance(deps, { projectId, runId, source: 'finalize' });

    // A separate run on the same project stalls.
    recordStalledNoResponse(deps, { projectId, runId: `${runId}-stall` });

    const res = await request.get(`/api/projects/${projectId}/finalize/metrics`).expect(200);

    // Find each metric in the response and assert its contents.
    type AggregateLike = {
      metric: string;
      kind: 'counter' | 'histogram';
      count?: number;
      groups: Array<{
        labels: Record<string, unknown>;
        count?: number;
        summary?: { count: number; avg: number | null };
      }>;
      summary?: { count: number; avg: number | null };
    };
    const byName = new Map<string, AggregateLike>();
    for (const m of res.body.metrics) byName.set(m.metric, m);

    expect(byName.get('finalize_run_started')?.count).toBe(1);
    expect(byName.get('finalize_run_completed')?.count).toBe(1);
    expect(byName.get('finalize_run_completed')?.groups[0].labels).toMatchObject({
      status: 'pushed',
      trigger_source: 'ui_button',
    });

    expect(byName.get('finalize_run_active_seconds')?.summary?.count).toBe(1);
    expect(byName.get('finalize_run_active_seconds')?.summary?.avg).toBe(1234);
    expect(byName.get('finalize_run_wall_seconds')?.summary?.count).toBe(1);
    expect(byName.get('finalize_run_wall_seconds')?.summary?.avg).toBe(1800);
    expect(byName.get('finalize_fix_dispatch_count')?.summary?.count).toBe(1);
    expect(byName.get('finalize_fix_dispatch_count')?.summary?.avg).toBe(1);

    const verdicts = byName.get('finalize_reviewer_verdict');
    expect(verdicts?.count).toBe(2);
    const changesReq = verdicts?.groups.find((g) => g.labels.verdict === 'changes_requested');
    expect(changesReq?.labels.attempt_index).toBe(1);
    const approved = verdicts?.groups.find((g) => g.labels.verdict === 'approved');
    expect(approved?.labels.attempt_index).toBe(2);

    const steps = byName.get('finalize_step_result');
    expect(steps?.count).toBe(4);
    const failedStep = steps?.groups.find(
      (g) => g.labels.step_name === 'tests' && g.labels.status === 'failed',
    );
    expect(failedStep?.labels.exit_code).toBe(1);
    expect(failedStep?.count).toBe(1);

    const stalled = byName.get('finalize_stalled_no_response_count');
    expect(stalled?.count).toBe(1);

    const provenance = byName.get('merged_pr_provenance');
    expect(provenance?.count).toBe(1);
    expect(provenance?.groups[0].labels.source).toBe('finalize');
  });
});
