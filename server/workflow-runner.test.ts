import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest, createProject, createAgent } from './test/helpers.js';
import { stmts } from './db.js';
import { findProject, getEnrichedAgent } from './project-model.js';
import {
  runWorkflowSequential,
  __clearWorkflowRunInFlightSetForTest,
  __clearWorkflowRunCancelRequestsForTest,
  requestWorkflowRunCancel,
  failStuckWorkflowRunsOnBoot,
} from './workflow-runner.js';
import { runClaude } from './heartbeat.js';

vi.mock('./heartbeat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./heartbeat.js')>();
  return { ...actual, runClaude: vi.fn().mockResolvedValue('mocked-cli') };
});

const broadcast = vi.fn();
const baseDeps = () => ({
  stmts: stmts!,
  broadcast,
  getEnrichedAgent,
  findProject,
});

describe('workflow runner', () => {
  beforeAll(async () => {
    await getRequest();
  }, 30_000);

  beforeEach(() => {
    __clearWorkflowRunInFlightSetForTest();
    __clearWorkflowRunCancelRequestsForTest();
    vi.mocked(runClaude).mockReset();
    vi.mocked(runClaude).mockResolvedValue('mocked-cli' as never);
  });

  it('completes a one-step run with merged payload (mocked CLI)', async () => {
    vi.mocked(runClaude).mockResolvedValue('out-text' as never);
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId, name: 'Wf' })) as { id: string };
    const wfId = uuidv4();
    const stepId = uuidv4();
    const runId = uuidv4();
    stmts!.createWorkflow.run(wfId, projectId, 'Flow', 'manual', '{"a":0}', null, null, null);
    stmts!.createWorkflowStep.run(
      stepId,
      wfId,
      agentId,
      'One',
      'Say {{trigger.payload.a}}',
      0,
      null,
      'abort',
      null,
      null,
    );
    stmts!.createWorkflowRun.run(runId, wfId, 'pending', '{"a":1}');

    await runWorkflowSequential(baseDeps(), { projectId, workflowId: wfId, runId });
    const row = stmts!.getWorkflowRun.get(runId) as { status: string; error: string | null };
    expect(row.status).toBe('success');
    expect(vi.mocked(runClaude).mock.calls.length).toBeGreaterThan(0);
    const userTurn = vi.mocked(runClaude).mock.calls[0][0] as string;
    expect(userTurn).toMatch(/# One/);
    expect(userTurn).toMatch(/1/);
  });

  it('on_failure=retry: rejects then succeeds on a later attempt (exercises resetWorkflowStepRunForRetry)', async () => {
    vi.mocked(runClaude)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('after-retry' as never);
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const wfId = uuidv4();
    const stepId = uuidv4();
    const runId = uuidv4();
    stmts!.createWorkflow.run(wfId, projectId, 'R', 'manual', '{}', null, null, null);
    stmts!.createWorkflowStep.run(stepId, wfId, agentId, 'R', 'x', 0, null, 'retry', null, null);
    stmts!.createWorkflowRun.run(runId, wfId, 'pending', null);

    await runWorkflowSequential(baseDeps(), { projectId, workflowId: wfId, runId });
    const row = stmts!.getWorkflowRun.get(runId) as { status: string };
    expect(row.status).toBe('success');
    expect(vi.mocked(runClaude).mock.calls.length).toBe(2);
  });

  it('on_failure=continue: run succeeds when the only step always fails', async () => {
    vi.mocked(runClaude).mockRejectedValue(new Error('always fails'));
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const wfId = uuidv4();
    const stepId = uuidv4();
    const runId = uuidv4();
    stmts!.createWorkflow.run(wfId, projectId, 'Continue', 'manual', '{}', null, null, null);
    stmts!.createWorkflowStep.run(
      stepId,
      wfId,
      agentId,
      'S',
      'do',
      0,
      null,
      'continue',
      null,
      null,
    );
    stmts!.createWorkflowRun.run(runId, wfId, 'pending', null);

    await runWorkflowSequential(baseDeps(), { projectId, workflowId: wfId, runId });
    const row = stmts!.getWorkflowRun.get(runId) as { status: string };
    expect(row.status).toBe('success');
  });

  it('on_failure=continue: second step sees empty prior output when the first step fails', async () => {
    vi.mocked(runClaude)
      .mockRejectedValueOnce(new Error('step1-bad'))
      .mockResolvedValueOnce('step2-ok' as never);
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const wfId = uuidv4();
    const step1 = uuidv4();
    const step2 = uuidv4();
    const runId = uuidv4();
    stmts!.createWorkflow.run(wfId, projectId, 'C', 'manual', '{}', null, null, null);
    stmts!.createWorkflowStep.run(step1, wfId, agentId, 'A', 'a1', 0, null, 'continue', null, null);
    stmts!.createWorkflowStep.run(
      step2,
      wfId,
      agentId,
      'B',
      `ref={{steps.${step1}.output}} tail`,
      1,
      null,
      'abort',
      null,
      null,
    );
    stmts!.createWorkflowRun.run(runId, wfId, 'pending', null);

    await runWorkflowSequential(baseDeps(), { projectId, workflowId: wfId, runId });
    const row = stmts!.getWorkflowRun.get(runId) as { status: string };
    expect(row.status).toBe('success');
    const p2 = vi.mocked(runClaude).mock.calls[1][0] as string;
    expect(p2).toMatch(/ref= tail/);
    expect(p2).not.toMatch(/step1-bad/);
  });

  it('on_failure=abort: run errors when the step throws', async () => {
    vi.mocked(runClaude).mockRejectedValue(new Error('no-recover'));
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const wfId = uuidv4();
    const stepId = uuidv4();
    const runId = uuidv4();
    stmts!.createWorkflow.run(wfId, projectId, 'A', 'manual', '{}', null, null, null);
    stmts!.createWorkflowStep.run(stepId, wfId, agentId, 'A', 'p', 0, null, 'abort', null, null);
    stmts!.createWorkflowRun.run(runId, wfId, 'pending', null);

    await runWorkflowSequential(baseDeps(), { projectId, workflowId: wfId, runId });
    const row = stmts!.getWorkflowRun.get(runId) as { status: string; error: string | null };
    expect(row.status).toBe('error');
    expect(String(row.error)).toMatch(/no-recover/);
  });

  it('feeds first step output into the second step via {{steps.<id>.output}}', async () => {
    vi.mocked(runClaude)
      .mockResolvedValueOnce('out-from-1' as never)
      .mockResolvedValueOnce('done' as never);
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const wfId = uuidv4();
    const step1 = uuidv4();
    const step2 = uuidv4();
    const runId = uuidv4();
    stmts!.createWorkflow.run(wfId, projectId, 'Two', 'manual', '{}', null, null, null);
    stmts!.createWorkflowStep.run(
      step1,
      wfId,
      agentId,
      'S1',
      'first',
      0,
      null,
      'abort',
      null,
      null,
    );
    stmts!.createWorkflowStep.run(
      step2,
      wfId,
      agentId,
      'S2',
      'use=' + '{{steps.' + step1 + '.output}}' + ' end',
      1,
      null,
      'abort',
      null,
      null,
    );
    stmts!.createWorkflowRun.run(runId, wfId, 'pending', null);

    await runWorkflowSequential(baseDeps(), { projectId, workflowId: wfId, runId });
    const row = stmts!.getWorkflowRun.get(runId) as { status: string };
    expect(row.status).toBe('success');
    const second = vi.mocked(runClaude).mock.calls[1][0] as string;
    expect(second).toContain('use=out-from-1 end');
  });

  it('cancels before any step when cancel is requested right after entering running', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const wfId = uuidv4();
    const stepId = uuidv4();
    const runId = uuidv4();
    stmts!.createWorkflow.run(wfId, projectId, 'C', 'manual', '{}', null, null, null);
    stmts!.createWorkflowStep.run(stepId, wfId, agentId, 'S', 'p', 0, null, 'abort', null, null);
    stmts!.createWorkflowRun.run(runId, wfId, 'pending', null);
    requestWorkflowRunCancel(runId);

    await runWorkflowSequential(baseDeps(), { projectId, workflowId: wfId, runId });
    const row = stmts!.getWorkflowRun.get(runId) as { status: string };
    expect(row.status).toBe('cancelled');
    expect(vi.mocked(runClaude).mock.calls.length).toBe(0);
  });

  it('stops after the first step when cancel is requested synchronously before step 2', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const wfId = uuidv4();
    const step1 = uuidv4();
    const step2 = uuidv4();
    const runId = uuidv4();
    stmts!.createWorkflow.run(wfId, projectId, 'Two', 'manual', '{}', null, null, null);
    stmts!.createWorkflowStep.run(step1, wfId, agentId, 'A', 'a', 0, null, 'abort', null, null);
    stmts!.createWorkflowStep.run(step2, wfId, agentId, 'B', 'b', 1, null, 'abort', null, null);
    stmts!.createWorkflowRun.run(runId, wfId, 'pending', null);
    let n = 0;
    vi.mocked(runClaude).mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        requestWorkflowRunCancel(runId);
        return 'first';
      }
      return 'second';
    });

    await runWorkflowSequential(baseDeps(), { projectId, workflowId: wfId, runId });
    const row = stmts!.getWorkflowRun.get(runId) as { status: string };
    expect(row.status).toBe('cancelled');
    expect(n).toBe(1);
  });

  it('marks stuck running runs and step runs on failStuckWorkflowRunsOnBoot', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const wfId = uuidv4();
    const stepId = uuidv4();
    const runId = uuidv4();
    const stepRunId = uuidv4();
    stmts!.createWorkflow.run(wfId, projectId, 'S', 'manual', '{}', null, null, null);
    stmts!.createWorkflowStep.run(stepId, wfId, agentId, 'S', 'p', 0, null, 'abort', null, null);
    stmts!.createWorkflowRun.run(runId, wfId, 'running', null);
    stmts!.createWorkflowStepRunStart.run(stepRunId, runId, stepId);

    failStuckWorkflowRunsOnBoot(stmts!);
    const r = stmts!.getWorkflowRun.get(runId) as { status: string; error: string | null };
    expect(r.status).toBe('error');
    expect(String(r.error)).toMatch(/interrupted/i);
    const sr = stmts!.getWorkflowStepRun.get(stepRunId) as {
      status: string;
      error: string | null;
    };
    expect(sr.status).toBe('error');
    expect(String(sr.error)).toMatch(/interrupted/i);
  });
});
