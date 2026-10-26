/**
 * Start a QA run end to end: pick the tool for the target, queue the run,
 * open a fresh QA session seeded with the in-scope cases, and mark the run
 * running. Shared by the Rerun / Start run route and the auto-rerun trigger,
 * so both refuse the same targets and recover the same way.
 *
 * If the session cannot be started the run is cancelled, so it never blocks
 * the plan as a phantom active run. Lifecycle refusals (`not_approved`,
 * `run_active`, `nothing_to_rerun`, ...) are thrown as `QaStatusError`.
 */
import { randomUUID } from 'crypto';
import { getStmts } from './db.js';
import { resolveAgentSpawnEngineAndModel } from './effective-model.js';
import { findProjectQaAgent } from './qa-authoring.js';
import { buildQaRunSeed, resolveQaTarget } from './qa-run-kickoff.js';
import { cancelQaRun, markQaRunRunning, qaRunCaseIds, startQaRun } from './qa-status.js';
import { abandonUnseededSession, kickoffSeededTurn } from './seeded-session-kickoff.js';
import { broadcastSessionCreated } from './session-checkpoint-rewind.js';
import { setSessionOwner } from './session-ownership.js';
import type { QaPlanRow, QaRunRow, QaRunScope, RouteDeps, SessionRow } from './types.js';

export type QaRunLaunchDeps = Pick<
  RouteDeps,
  'findProject' | 'broadcast' | 'handleChat' | 'getDevServerRuntime' | 'config'
>;

export type QaRunLaunchResult =
  | { ok: true; plan: QaPlanRow; run: QaRunRow; sessionId: string; agentId: string }
  | {
      ok: false;
      status: 404 | 409 | 502 | 503;
      code:
        | 'no_project'
        | 'no_qa_agent'
        | 'chat_unavailable'
        | 'target_unreachable'
        | 'spawn_failed';
      error: string;
      runId?: string;
    };

export async function launchQaRun(
  deps: QaRunLaunchDeps,
  plan: QaPlanRow,
  opts: { scope?: QaRunScope; startedBy: string | null; ownerUserId: string | null },
): Promise<QaRunLaunchResult> {
  const project = deps.findProject(plan.project_id);
  if (!project) {
    return { ok: false, status: 404, code: 'no_project', error: 'Project not found' };
  }
  const agent = findProjectQaAgent(project);
  if (!agent) {
    return {
      ok: false,
      status: 409,
      code: 'no_qa_agent',
      error: 'This project has no QA agent. Add an agent with the qa role first.',
    };
  }
  if (!deps.handleChat) {
    return {
      ok: false,
      status: 503,
      code: 'chat_unavailable',
      error: 'Chat is unavailable on this server',
    };
  }

  const s = getStmts();
  // One decision for tool and preview session. A preview-routed target must
  // identify exactly one live session of this project; otherwise refuse.
  const devServer = deps.getDevServerRuntime?.() ?? null;
  const routing = resolveQaTarget(plan.target_url, {
    previewSubdomainBase: deps.config?.previewSubdomainBase,
    hubPublicUrl: deps.config?.publicUrl,
    activePreviews: devServer?.listActive?.() ?? [],
    primaryInternalPort: (id) => {
      const group = devServer?.getActiveBySessionId?.(id);
      if (!group) return null;
      return devServer?.getPorts?.(group.id).find((p) => p.primary)?.internalPort ?? null;
    },
    isProjectSession: (id) => {
      const row = s.getSession.get(id) as SessionRow | undefined;
      return !!row && !row.deleted_at && !!project.agents?.some((a) => a.id === row.agent_id);
    },
  });
  if (routing.tool === 'unreachable') {
    return { ok: false, status: 409, code: 'target_unreachable', error: routing.reason };
  }
  const previewSessionId = routing.tool === 'preview' ? routing.previewSessionId : null;

  const started = startQaRun(plan.id, { scope: opts.scope, startedBy: opts.startedBy });
  const run = started.run;
  const inScope = new Set(qaRunCaseIds(run));
  const seed = buildQaRunSeed({
    project,
    plan: started.plan,
    run,
    cases: s.listQaCasesByPlan.all(plan.id).filter((c) => inScope.has(c.id)),
    routing,
  });
  const sessionId = randomUUID();
  try {
    const { engine, model } = resolveAgentSpawnEngineAndModel(deps.config, agent, opts.ownerUserId);
    // QA sessions never get a worktree: they are read-only on code.
    s.createSession.run(
      sessionId,
      agent.id,
      `[QA run #${run.iteration}] ${plan.title}`.slice(0, 100),
      engine,
      model,
      0,
      0,
      1,
    );
    setSessionOwner(sessionId, opts.ownerUserId);
    s.updateSessionMode.run('qa', sessionId);
    s.setQaRunSession.run(sessionId, run.id);
    if (previewSessionId) s.setQaRunPreviewSession.run(previewSessionId, run.id);
    markQaRunRunning(run.id);
    await kickoffSeededTurn({
      handleChat: deps.handleChat,
      agentId: agent.id,
      sessionId,
      content: seed,
      // A cancel that lands before the seed persists drops the turn.
      acceptTurn: () => s.getQaRun.get(run.id)?.status === 'running',
    });
  } catch (e) {
    console.error('[qa] run session failed to start:', e);
    s.setQaRunSession.run(null, run.id);
    abandonUnseededSession(s, sessionId);
    const current = s.getQaRun.get(run.id);
    if (current && (current.status === 'queued' || current.status === 'running')) {
      cancelQaRun(run.id);
    }
    deps.broadcast({
      type: 'qa_update',
      projectId: plan.project_id,
      planId: plan.id,
      action: 'run_cancelled',
      runId: run.id,
    });
    return {
      ok: false,
      status: 502,
      code: 'spawn_failed',
      error: 'Failed to start the QA run session',
      runId: run.id,
    };
  }
  const session = s.getSession.get(sessionId) as SessionRow;
  broadcastSessionCreated(deps.broadcast, agent.id, session, s, project);
  deps.broadcast({
    type: 'qa_update',
    projectId: plan.project_id,
    planId: plan.id,
    action: 'run_started',
    runId: run.id,
  });
  return {
    ok: true,
    plan: s.getQaPlan.get(plan.id)!,
    run: s.getQaRun.get(run.id)!,
    sessionId,
    agentId: agent.id,
  };
}
