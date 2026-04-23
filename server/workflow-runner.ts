import { v4 as uuidv4 } from 'uuid';
import { runClaude } from './heartbeat.js';
import { getOrCreateProcessWorktree } from './worktree.js';
import { buildEnrichedPrompt } from './chat.js';
import { getProjectMode } from './project-mode.js';
import config from './config.js';
import { substituteWorkflowTemplate, mergeWorkflowTriggerPayload } from './workflow-templates.js';
import type { Stmts, BroadcastFn, EnrichedAgent, Project } from './types.js';

const MAX_RETRIES = 3;

const runningWorkflowSets = new Set<string>();

type RunnerDeps = {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getEnrichedAgent: (id: string) => EnrichedAgent | null;
  findProject: (id: string) => Project | null;
};

type WorkflowRunRow = {
  id: string;
  workflow_id: string;
  status: string;
  run_payload: string | null;
  error: string | null;
};

type WorkflowDefRow = {
  id: string;
  project_id: string;
  default_payload: string;
  name: string;
};

type WorkflowStepRow = {
  id: string;
  agent_id: string;
  title: string;
  role_prompt: string;
  step_order: number;
  timeout_ms: number | null;
  on_failure: string;
};

/**
 * Mark in-flight `running` runs / step_runs as failed (server restart or crash).
 */
export function failStuckWorkflowRunsOnBoot(stmts: Stmts): void {
  try {
    const w = stmts.failStuckRunningWorkflowRuns.run() as { changes: number };
    if (w.changes > 0) {
      console.warn(`[workflow] Marked ${w.changes} stuck workflow run(s) as error on boot`);
    }
  } catch (e) {
    console.error('[workflow] failStuckRunningWorkflowRuns', (e as Error).message);
  }
  try {
    const w = stmts.failStuckRunningWorkflowStepRuns.run() as { changes: number };
    if (w.changes > 0) {
      console.warn(`[workflow] Marked ${w.changes} stuck workflow step run(s) as error on boot`);
    }
  } catch (e) {
    console.error('[workflow] failStuckRunningWorkflowStepRuns', (e as Error).message);
  }
}

export function startWorkflowRun(
  deps: RunnerDeps,
  args: { projectId: string; workflowId: string; runId: string },
): void {
  const { runId } = args;
  if (runningWorkflowSets.has(runId)) return;
  // Consider claiming `runId` in this Set synchronously before setImmediate
  // so a duplicate `POST .../runs` for the same id cannot enqueue two executors; today the race is narrow.
  setImmediate(() => {
    void runWorkflowSequential(deps, args);
  });
}

function safePersistRunError(stmts: Stmts, runId: string, msg: string) {
  try {
    stmts.updateWorkflowRunTerminal.run('error', msg, runId);
  } catch (dbErr) {
    console.warn(
      '[workflow] failed to persist run failure state:',
      dbErr instanceof Error ? dbErr.message : String(dbErr),
    );
  }
}

export async function runWorkflowSequential(
  deps: RunnerDeps,
  args: { projectId: string; workflowId: string; runId: string },
): Promise<void> {
  const { projectId, workflowId, runId } = args;
  const { stmts, broadcast, getEnrichedAgent, findProject } = deps;
  if (runningWorkflowSets.has(runId)) return;
  runningWorkflowSets.add(runId);

  try {
    const runRow = stmts.getWorkflowRun.get(runId) as WorkflowRunRow | undefined;
    if (!runRow || runRow.status !== 'pending' || runRow.workflow_id !== workflowId) {
      return;
    }
    const wf = stmts.getWorkflow.get(workflowId) as WorkflowDefRow | undefined;
    if (!wf || wf.id !== workflowId) {
      stmts.updateWorkflowRunTerminal.run('error', 'Workflow not found', runId);
      return;
    }
    if (wf.project_id !== projectId) {
      stmts.updateWorkflowRunTerminal.run('error', 'Project mismatch for workflow', runId);
      return;
    }
    const project = findProject(projectId);
    if (!project) {
      stmts.updateWorkflowRunTerminal.run('error', 'Project not found', runId);
      return;
    }

    stmts.updateWorkflowRunToRunning.run(runId);
    broadcast({
      type: 'workflow_run_status',
      projectId,
      workflowId,
      runId,
      status: 'running',
    });

    const steps = stmts.getWorkflowSteps.all(workflowId) as WorkflowStepRow[];
    const triggerPayload = mergeWorkflowTriggerPayload(wf.default_payload, runRow.run_payload);
    const stepOutputs = new Map<string, string>();

    if (steps.length === 0) {
      stmts.updateWorkflowRunTerminal.run('success', null, runId);
      broadcast({ type: 'workflow_run_status', projectId, workflowId, runId, status: 'success' });
      return;
    }

    const useWtForPrompt = getProjectMode(project) !== 'workflow';

    for (const step of steps) {
      const of = (step.on_failure as string) || 'abort';
      const ctx = { triggerPayload, stepOutputs };
      const title = substituteWorkflowTemplate(step.title, ctx);
      const body = substituteWorkflowTemplate(step.role_prompt, ctx);
      const userContent = `# ${title}\n\n${body}`.trim();

      const stepRunId = uuidv4();
      stmts.createWorkflowStepRunStart.run(stepRunId, runId, step.id);

      let lastErr = 'Step failed';
      let stepOK = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          stmts.resetWorkflowStepRunForRetry.run(stepRunId);
        }
        const enriched = getEnrichedAgent(step.agent_id);
        if (!enriched || enriched.projectId !== projectId) {
          lastErr = 'Agent not found in project';
          stmts.updateWorkflowStepRunComplete.run('error', null, lastErr, stepRunId);
          if (of === 'continue') {
            stepOutputs.set(step.id, '');
            stepOK = true;
            broadcast({
              type: 'workflow_run_status',
              projectId,
              workflowId,
              runId,
              status: 'running',
              stepId: step.id,
              stepStatus: 'error-continued',
            });
            break;
          }
          break;
        }
        const systemPrompt = buildEnrichedPrompt(project, enriched, {
          useWorktree: useWtForPrompt,
        });
        const workDir = getOrCreateProcessWorktree(
          enriched.cwd,
          `wf-${runId.slice(0, 8)}-${step.id.slice(0, 8)}-a${attempt}`,
        );
        const timeoutMs =
          typeof step.timeout_ms === 'number' && step.timeout_ms > 0
            ? step.timeout_ms
            : config.defaultTimeoutMs;
        // MVP: always the heartbeat/cron one-shot (Claude CLI), not the agent’s interactive engine in handleChat.
        try {
          const out = (await runClaude(userContent, workDir, systemPrompt, {
            timeoutMs,
          })) as string;
          stmts.updateWorkflowStepRunComplete.run('success', out, null, stepRunId);
          stepOutputs.set(step.id, out);
          stepOK = true;
          broadcast({
            type: 'workflow_run_status',
            projectId,
            workflowId,
            runId,
            status: 'running',
            stepId: step.id,
            stepStatus: 'success',
          });
          lastErr = '';
          break;
        } catch (e) {
          lastErr = (e as Error).message || String(e);
          const canRetry = of === 'retry' && attempt < MAX_RETRIES - 1;
          if (canRetry) {
            continue;
          }
          if (of === 'continue') {
            stmts.updateWorkflowStepRunComplete.run('error', null, lastErr, stepRunId);
            stepOutputs.set(step.id, '');
            stepOK = true;
            broadcast({
              type: 'workflow_run_status',
              projectId,
              workflowId,
              runId,
              status: 'running',
              stepId: step.id,
              stepStatus: 'error-continued',
            });
          } else {
            stmts.updateWorkflowStepRunComplete.run('error', null, lastErr, stepRunId);
            stepOK = false;
          }
          break;
        }
      }

      if (!stepOK) {
        stmts.updateWorkflowRunTerminal.run('error', lastErr, runId);
        broadcast({
          type: 'workflow_run_status',
          projectId,
          workflowId,
          runId,
          status: 'error',
          error: lastErr,
        });
        return;
      }
    }

    stmts.updateWorkflowRunTerminal.run('success', null, runId);
    broadcast({ type: 'workflow_run_status', projectId, workflowId, runId, status: 'success' });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    safePersistRunError(stmts, runId, msg);
    try {
      broadcast({
        type: 'workflow_run_status',
        projectId,
        workflowId,
        runId,
        status: 'error',
        error: msg,
      });
    } catch {
      // Best-effort — broadcast should not create an unhandled rejection
    }
  } finally {
    runningWorkflowSets.delete(runId);
  }
}

/** @internal */
export function __clearWorkflowRunInFlightSetForTest(): void {
  runningWorkflowSets.clear();
}
