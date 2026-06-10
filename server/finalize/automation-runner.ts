/**
 * Fire-and-forget Finalize automation — auto-start on session end and
 * auto-push when a run reaches ready_to_push.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { FinalizeRunRow, KanbanCardRow, Project, RouteDeps, SessionRow } from '../types.js';
import { resolveShouldAutoMerge } from '../auto-merge.js';
import { autoGitChildEnv, resolveOrgOwnerGithubToken } from '../auto-git.js';
import { ensureKanbanCardForSession } from './ensure-kanban-card.js';
import { runFinalizePush } from './push-run.js';
import { startFinalizeRunBackground } from './trigger-run.js';
import {
  resolveSessionFinalizeAutomation,
  shouldAutoPushAfterReady,
  shouldAutoStartFinalize,
  shouldEnableAutoMergeForAutomation,
} from './automation.js';
import { getSessionCommittableChanges } from './worktree-changes.js';
import { flakeGateBlocksAutoPush, parseFlakeGate } from './flake-recovery.js';

const execFileAsync = promisify(execFile);

let routeDeps: RouteDeps | null = null;

export function setFinalizeAutomationRouteDeps(deps: RouteDeps): void {
  routeDeps = deps;
}

async function enableGithubAutoMerge(
  prUrl: string,
  project: Project,
  override: boolean | undefined,
  cwd: string,
): Promise<void> {
  if (!routeDeps) return;
  if (!resolveShouldAutoMerge(override, project.githubWorkflow)) return;
  try {
    const token = await resolveOrgOwnerGithubToken(routeDeps.config, project.githubRepo ?? null);
    const env = autoGitChildEnv(token);
    await execFileAsync('gh', ['pr', 'merge', '--auto', '--squash', prUrl], {
      cwd,
      env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    console.log(`[finalize-automation] Enabled GitHub native auto-merge for ${prUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[finalize-automation] Failed to enable auto-merge for ${prUrl}: ${msg}`);
  }
}

/**
 * True (and logs why) when the session's last turn ended in an engine/API
 * error — see `sessions.last_turn_error` (written by chat.ts via
 * `server/turn-error.ts`). Blocks fire-and-forget automation only; manual
 * Finalize routes do not consult this flag.
 */
function sessionTurnErrorBlocksAutomation(
  session: SessionRow,
  sessionId: string,
  action: 'auto-start' | 'auto-push',
): boolean {
  const lastTurnError = session.last_turn_error;
  if (!lastTurnError) return false;
  console.warn(
    `[finalize-automation] Skipping ${action} session=${sessionId}: last turn ended in error ` +
      `(${lastTurnError.slice(0, 200)}). Waiting for a clean turn or a manual Finalize run.`,
  );
  return true;
}

async function loadSessionContext(sessionId: string): Promise<{
  session: SessionRow;
  project: Project;
  card: KanbanCardRow;
} | null> {
  if (!routeDeps) return null;
  const session = routeDeps.stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!session?.worktree_path) return null;
  const lookup = routeDeps.findAgent(session.agent_id);
  if (!lookup) return null;
  const { card } = ensureKanbanCardForSession(
    {
      stmts: routeDeps.stmts,
      broadcast: routeDeps.broadcast,
      findAgent: routeDeps.findAgent,
    },
    { projectId: lookup.project.id, session, createdBy: null },
  );
  return { session, project: lookup.project, card };
}

/**
 * After session end / changes_ready: start Finalize when automation level
 * is review, push, or merge.
 */
export async function maybeAutoStartFinalizeForSession(sessionId: string): Promise<void> {
  if (!routeDeps) return;
  const ctx = await loadSessionContext(sessionId);
  if (!ctx) return;

  // Fail-closed turn-error gate: if the session's last turn ended in an
  // upstream engine/API error (e.g. "API Error: The socket connection was
  // closed unexpectedly"), the worktree may hold a half-finished change set.
  // Never auto-start Finalize on it — wait for a clean turn (the transient
  // auto-retry in chat.ts usually provides one) or an explicit manual run.
  if (sessionTurnErrorBlocksAutomation(ctx.session, sessionId, 'auto-start')) return;

  const level = resolveSessionFinalizeAutomation(ctx.session);
  if (!shouldAutoStartFinalize(level)) return;

  const committable = await getSessionCommittableChanges(ctx.session.worktree_path!);
  if (!committable.ok) return;

  const latest = routeDeps.stmts.getLatestFinalizeRunForSession.get(sessionId) as
    | FinalizeRunRow
    | undefined;
  if (latest?.status === 'ready_to_push' && shouldAutoPushAfterReady(level)) {
    void maybeAutoPushReadyFinalizeRun({ sessionId, runId: latest.id });
    return;
  }

  const started = await startFinalizeRunBackground(routeDeps, {
    project: ctx.project,
    card: ctx.card,
    session: ctx.session,
    triggerSource: 'agent_block',
    triggeredByUserId: 'automation',
  });
  if (!started.ok && started.error === 'ready_to_push' && shouldAutoPushAfterReady(level)) {
    void maybeAutoPushReadyFinalizeRun({ sessionId, runId: started.runId! });
  }
}

/**
 * When a run parks at ready_to_push, auto-push (and optionally auto-merge)
 * if the session automation level allows it.
 */
export async function maybeAutoPushReadyFinalizeRun(args: {
  sessionId: string;
  runId: string;
}): Promise<void> {
  if (!routeDeps) return;
  const ctx = await loadSessionContext(args.sessionId);
  if (!ctx) return;

  // Same fail-closed gate as auto-start: a ready_to_push run parked before
  // the errored turn must not auto-push/auto-merge over it.
  if (sessionTurnErrorBlocksAutomation(ctx.session, args.sessionId, 'auto-push')) return;

  const level = resolveSessionFinalizeAutomation(ctx.session);
  if (!shouldAutoPushAfterReady(level)) return;

  const run = routeDeps.stmts.getFinalizeRun.get(args.runId) as FinalizeRunRow | undefined;
  if (!run || run.status !== 'ready_to_push') return;

  // Flake-recovery gate (fail-closed): block auto-push/auto-merge unless the
  // run's flake gate is proven `clean`. A `flake_recovered` run laundered an
  // earlier failure into green; a `blocked` run could not be classified (its
  // per-round history failed to persist or was unreadable). Neither is
  // auto-merge-safe — both require an explicit human push to acknowledge.
  if (flakeGateBlocksAutoPush(run)) {
    const gate = parseFlakeGate(run.flake_recovered_jobs);
    console.warn(
      `[finalize-automation] Skipping auto-push session=${args.sessionId} run=${args.runId}: ` +
        `flake gate status=${gate.status}` +
        (gate.reason ? ` (${gate.reason})` : '') +
        ` requires explicit human acknowledgement (manual push)`,
    );
    return;
  }

  const outcome = await runFinalizePush({
    deps: routeDeps,
    project: ctx.project,
    run,
    card: ctx.card,
    session: ctx.session,
  });
  if (!outcome.ok) {
    console.warn(
      `[finalize-automation] Auto-push failed session=${args.sessionId} run=${args.runId}: ${outcome.message ?? outcome.error}`,
    );
    return;
  }
  if (outcome.prUrl && shouldEnableAutoMergeForAutomation(level)) {
    void enableGithubAutoMerge(outcome.prUrl, ctx.project, true, ctx.session.worktree_path!);
  }
}
