/**
 * Autopilot unstick — kill a hung session turn, cancel in-flight Finalize/CI,
 * clear the queue, and send a continue prompt from the current worktree.
 *
 * After a dropped network the CLI can stay registered in `activeProcesses`
 * (or a stale `active_tasks` row can keep the session "busy"), so every human
 * message queues forever. Unstick force-kills that process, then kicks a
 * resume turn that is not an automatic crash-resume (`_autoResume` unset).
 */
import { v4 as uuidv4 } from 'uuid';
import type { ActiveChatProcess } from './active-chat-process.js';
import { abortFinalizeRunInProcess, isFinalizeRunLive } from './finalize/run-abort-registry.js';
import { activeMultiAgentRounds, handleMultiAgentCancel } from './session-multi-agent.js';
import { forceKillSessionChatRun } from './session-chat-cancel.js';
import { isSessionWorktreeLocked } from './session-worktree-lock.js';
import {
  beginSessionRecovery,
  allowSessionRecoveryTurn,
  endSessionRecovery,
} from './session-recovery.js';
import { recomputeSessionState } from './session-state.js';
import { kickoffSeededTurn } from './seeded-session-kickoff.js';
import { isAutopilotModeActive } from './session-mode.js';
import {
  autopilotConfigFromSession,
  isAutopilotRunning,
  buildAutopilotUnstickContinueMessage,
} from '../shared/utils/sessionAutopilot.js';
import type { BroadcastFn, ChatMessage, FinalizeRunRow, SessionRow, Stmts } from './types.js';

export const UNSTICK_PROCESS_WAIT_MS = 2000;

export type UnstickAutopilotOk = {
  ok: true;
  killedProcess: boolean;
  cancelledFinalizeRunId: string | null;
};

export type UnstickAutopilotErr = {
  ok: false;
  status: number;
  error: string;
  message: string;
};

export type UnstickAutopilotResult = UnstickAutopilotOk | UnstickAutopilotErr;

export interface UnstickAutopilotDeps {
  sessionId: string;
  stmts: Stmts;
  broadcast: BroadcastFn;
  activeProcesses: Map<string, ActiveChatProcess>;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

export async function waitWhileHandleRegistered(args: {
  sessionId: string;
  handle: ActiveChatProcess;
  activeProcesses: Map<string, ActiveChatProcess>;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const timeoutMs = args.timeoutMs ?? UNSTICK_PROCESS_WAIT_MS;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  while (args.activeProcesses.get(args.sessionId) === args.handle) {
    if (now() - started >= timeoutMs) return false;
    await sleep(50);
  }
  return true;
}

function cancelActiveFinalizeRun(args: {
  stmts: Stmts;
  broadcast: BroadcastFn;
  sessionId: string;
  run: FinalizeRunRow | undefined;
}): string | null {
  const { stmts, broadcast, sessionId } = args;
  const { run } = args;
  if (!run) return null;
  try {
    stmts.failFinalizeRun.run('cancelled', 'cancelled', run.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[autopilot-unstick] failFinalizeRun failed run=${run.id}: ${message}`);
  }
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: run.id,
    session_id: sessionId,
    phase: null,
    status: 'cancelled',
    failure_reason: 'cancelled',
  });
  broadcast({
    type: 'finalize_run_completed',
    run_id: run.id,
    session_id: sessionId,
    status: 'cancelled',
  });
  return run.id;
}

function appendUnstickSystemMessage(args: {
  stmts: Stmts;
  broadcast: BroadcastFn;
  sessionId: string;
  cancelledFinalizeRunId: string | null;
}): void {
  const { stmts, broadcast, sessionId, cancelledFinalizeRunId } = args;
  const extras = cancelledFinalizeRunId ? ` Cancelled Finalize run ${cancelledFinalizeRunId}.` : '';
  const body = `Autopilot unstuck — stopped the hung turn and queued messages.${extras} Continuing from the current worktree.`;
  try {
    const msgId = uuidv4();
    stmts.addMessage.run(
      msgId,
      sessionId,
      'system',
      body,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    try {
      stmts.touchSession.run(sessionId);
    } catch {
      /* best-effort */
    }
    const inserted = stmts.getMessageById.get(msgId);
    if (inserted) {
      broadcast({ type: 'message', sessionId, message: inserted });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[autopilot-unstick] system message insert failed session=${sessionId}: ${message}`,
    );
  }
}

async function recoverAutopilotSession(
  deps: UnstickAutopilotDeps,
): Promise<UnstickAutopilotResult> {
  const { sessionId, stmts, broadcast, activeProcesses, handleChat } = deps;
  const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!session) {
    return { ok: false, status: 404, error: 'not_found', message: 'Session not found' };
  }
  if (!isAutopilotModeActive(session)) {
    return {
      ok: false,
      status: 400,
      error: 'not_autopilot',
      message: 'Unstick is only available on Autopilot sessions.',
    };
  }
  const cfg = autopilotConfigFromSession(session);
  if (!isAutopilotRunning(cfg) || !cfg) {
    return {
      ok: false,
      status: 409,
      error: 'autopilot_not_running',
      message: 'Autopilot is not running on this session.',
    };
  }

  // Clear queued intent before kill: close handlers may synchronously drain it.
  // Failure to clear must stop recovery rather than dispatch old queued work.
  stmts.clearSessionQueue.run(sessionId);
  broadcast({ type: 'queue_updated', sessionId, queue: [] });
  const run = stmts.getActiveFinalizeRunForSession.get(sessionId) as FinalizeRunRow | undefined;
  if (run) abortFinalizeRunInProcess(run.id);
  handleMultiAgentCancel(sessionId);
  const killedHandle = forceKillSessionChatRun({ sessionId, activeProcesses });
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  // Never revoke ownership. Finalize may still be fetching/rebasing after abort,
  // and a kill request does not prove that a host or guest process has exited.
  while (
    activeProcesses.has(sessionId) ||
    activeMultiAgentRounds.has(sessionId) ||
    (run && isFinalizeRunLive(run.id)) ||
    isSessionWorktreeLocked(sessionId)
  ) {
    if (now() - started >= (deps.waitMs ?? UNSTICK_PROCESS_WAIT_MS)) {
      return {
        ok: false,
        status: 409,
        error: 'autopilot_unstick_still_stopping',
        message:
          'The previous operation has not stopped yet. Recovery remains blocked; retry once it settles.',
      };
    }
    await sleep(50);
  }
  const cancelledFinalizeRunId = cancelActiveFinalizeRun({ stmts, broadcast, sessionId, run });
  stmts.deleteActiveTask.run(sessionId);
  broadcast({ type: 'interrupted', sessionId });
  recomputeSessionState(stmts, sessionId, { agentId: session.agent_id, broadcast });
  appendUnstickSystemMessage({ stmts, broadcast, sessionId, cancelledFinalizeRunId });

  try {
    // Keep drainQueue suspended until the recovery message is accepted. The
    // ordinary chat lock protects its startup from new incoming messages.
    allowSessionRecoveryTurn(sessionId);
    await kickoffSeededTurn({
      handleChat,
      agentId: session.agent_id,
      sessionId,
      content: buildAutopilotUnstickContinueMessage(cfg),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 409,
      error: 'autopilot_unstick_continue_failed',
      message,
    };
  }

  return {
    ok: true,
    killedProcess: Boolean(killedHandle),
    cancelledFinalizeRunId,
  };
}

// Concurrent clicks share one cancellation and one recovery turn.
const recoveries = new Map<string, Promise<UnstickAutopilotResult>>();

export function unstickAutopilotSession(
  deps: UnstickAutopilotDeps,
): Promise<UnstickAutopilotResult> {
  const existing = recoveries.get(deps.sessionId);
  if (existing) return existing;
  beginSessionRecovery(deps.sessionId);
  const recovery = Promise.resolve()
    .then(() => recoverAutopilotSession(deps))
    .catch(
      (err: unknown): UnstickAutopilotErr => ({
        ok: false,
        status: 500,
        error: 'autopilot_unstick_failed',
        message: err instanceof Error ? err.message : String(err),
      }),
    )
    .finally(() => {
      recoveries.delete(deps.sessionId);
      endSessionRecovery(deps.sessionId);
    });
  recoveries.set(deps.sessionId, recovery);
  return recovery;
}
