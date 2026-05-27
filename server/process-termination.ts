import { v4 as uuidv4 } from 'uuid';
import { stripAssistantControlBlocks } from '../shared/utils/stripAssistantControlBlocks.js';
import type { BroadcastFn, MessageRow, SessionRow, Stmts } from './types.js';

/**
 * Why the Hub sent SIGTERM/SIGKILL to a session-scoped CLI child.
 * Set immediately before `killProcessGroup` / `proc.kill`, consumed on `close`.
 */
export type ProcessTerminationReason =
  | 'user_cancel'
  | 'chat_interrupt'
  | 'chat_interrupt_queued'
  | 'chat_wall_timeout'
  | 'heartbeat_wall_timeout'
  | 'session_deleted'
  | 'task_stopped'
  | 'server_shutdown'
  | 'reviewer_cleanup'
  | 'unknown_signal';

const pendingBySession = new Map<string, ProcessTerminationReason>();

export function markSessionTermination(sessionId: string, reason: ProcessTerminationReason): void {
  pendingBySession.set(sessionId, reason);
}

export function consumeSessionTermination(sessionId: string): ProcessTerminationReason | null {
  const reason = pendingBySession.get(sessionId) ?? null;
  pendingBySession.delete(sessionId);
  return reason;
}

/** Node `close` with signal set, or shell-style 128+signal exit codes. */
export function isSignalTermination(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGINT' || signal === 'SIGHUP') {
    return true;
  }
  if (code === 143 || code === 137 || code === 130 || code === 129) return true;
  if (code != null && code > 128) {
    const sigNum = code - 128;
    return sigNum === 15 || sigNum === 9 || sigNum === 2 || sigNum === 1;
  }
  return false;
}

export function formatChildExitInfo(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) {
    return code != null && code !== 0 ? `signal=${signal} code=${code}` : `signal=${signal}`;
  }
  if (code === null) return 'code=null';
  return `code=${code}`;
}

export function terminationReasonLabel(reason: ProcessTerminationReason): string {
  switch (reason) {
    case 'user_cancel':
      return 'you cancelled the run (Stop / Cancel)';
    case 'chat_interrupt':
      return 'a new message interrupted the current run';
    case 'chat_interrupt_queued':
      return 'interrupt-now on a queued message stopped the current run';
    case 'chat_wall_timeout':
      return 'chat wall timeout (run exceeded the configured time limit)';
    case 'heartbeat_wall_timeout':
      return 'heartbeat wall timeout (scheduled check-in exceeded the time limit)';
    case 'session_deleted':
      return 'the session was archived or deleted';
    case 'task_stopped':
      return 'the background task was stopped';
    case 'server_shutdown':
      return 'the Agent Hub server is shutting down';
    case 'reviewer_cleanup':
      return 'reviewer session cleanup reclaimed this run';
    case 'unknown_signal':
      return 'the CLI process was terminated (cause not recorded)';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function buildRunCancelledSystemMessage(reason: ProcessTerminationReason): string {
  return `Run cancelled — reason: ${terminationReasonLabel(reason)}`;
}

export function formatChatExitLog(opts: {
  engine: string;
  sessionId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: ProcessTerminationReason | null;
}): string {
  const exitInfo = formatChildExitInfo(opts.code, opts.signal);
  const source =
    opts.reason ??
    (isSignalTermination(opts.code, opts.signal) ? ('unknown_signal' as const) : null);
  const sourcePart = source ? ` source=${source}` : '';
  return `[chat] ${opts.engine} exited ${exitInfo} session=${opts.sessionId}${sourcePart}`;
}

export interface RunCancelledNotifyDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

/**
 * Insert a user-visible `role=system` line and broadcast it (best-effort).
 */
export function appendRunCancelledSystemMessage(
  deps: RunCancelledNotifyDeps,
  sessionId: string,
  reason: ProcessTerminationReason,
): void {
  const { stmts, broadcast } = deps;
  const body = buildRunCancelledSystemMessage(reason);
  try {
    const msgId = uuidv4();
    stmts.addMessage.run(msgId, sessionId, 'system', body, null, null, null, null);
    try {
      stmts.touchSession.run(sessionId);
    } catch {
      /* best-effort */
    }
    const inserted = stmts.getMessageById.get(msgId) as MessageRow | undefined;
    if (inserted) {
      try {
        broadcast({ type: 'message', sessionId, message: inserted });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[chat] run-cancelled message broadcast failed for ${sessionId}: ${message}`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[chat] run-cancelled system message insert failed session=${sessionId} reason=${reason}: ${message}`,
    );
  }
}

export interface ResolvedChatTermination {
  terminated: boolean;
  reason: ProcessTerminationReason;
}

export interface FinalizeTerminatedChatTurnParams {
  stmts: Stmts;
  broadcast: BroadcastFn;
  sessionId: string;
  assistantMsgId: string;
  engine: string;
  model: string | null;
  agentId: string;
  agentName: string;
  /** Streamed assistant text accumulated before SIGTERM (may be empty). */
  assembled: string;
}

/**
 * Persist partial assistant output after a hub-initiated kill, without running
 * ReAct / auto-continuation. Called from the chat `close` handler once the
 * cancel system message has been written.
 */
export function finalizeChatRunAfterTermination(params: FinalizeTerminatedChatTurnParams): void {
  const partialContent = stripAssistantControlBlocks(params.assembled).trim();
  if (!partialContent) return;

  const { stmts, broadcast, sessionId, assistantMsgId, engine, model, agentId, agentName } = params;
  try {
    stmts.addMessage.run(
      assistantMsgId,
      sessionId,
      'assistant',
      partialContent,
      engine,
      model,
      null,
      null,
    );
    stmts.touchSession.run(sessionId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[chat] partial assistant save failed after termination session=${sessionId}: ${message}`,
    );
    return;
  }

  const sess = stmts.getSession.get(sessionId) as SessionRow | undefined;
  try {
    broadcast({
      type: 'done',
      messageId: assistantMsgId,
      sessionId,
      agentId,
      agentName,
      sessionName: sess?.name,
      message: {
        id: assistantMsgId,
        session_id: sessionId,
        role: 'assistant',
        content: partialContent,
        engine,
        model,
        created_at: new Date().toISOString(),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[chat] partial assistant done broadcast failed session=${sessionId}: ${message}`);
  }
}

/**
 * If the child exited from a signal, consume the pending reason (or unknown).
 */
export function resolveChatTerminationOnClose(
  sessionId: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): ResolvedChatTermination | null {
  if (!isSignalTermination(code, signal)) return null;
  const reason = consumeSessionTermination(sessionId) ?? 'unknown_signal';
  return { terminated: true, reason };
}
