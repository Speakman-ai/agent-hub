import { v4 as uuidv4 } from 'uuid';
import type { Agent, BroadcastFn, MessageRow, SessionRow, Stmts } from './types.js';
import {
  COMMIT_NUDGE_KIND,
  COMMIT_NUDGE_SYSTEM_MESSAGE,
  buildCommitNudgeCliPrompt,
} from './local-commit-reminder.js';

export interface TriggerUncommittedCommitNudgeArgs {
  sessionId: string;
  session: SessionRow;
  agent: Agent;
  stmts: Stmts;
  broadcast: BroadcastFn;
  activeProcesses: Map<string, unknown>;
  branch: string;
  porcelain?: string;
  handleChat: (
    ws: null,
    msg: {
      type: 'chat';
      agentId: string;
      sessionId: string;
      content: string;
      _skipUserMessagePersist?: boolean;
    },
  ) => Promise<void>;
}

export type TriggerUncommittedCommitNudgeResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code?: string };

const sessionsWithNudgeInFlight = new Set<string>();

/** Test-only reset for the in-flight guard. */
export function resetCommitNudgeInFlightForTests(): void {
  sessionsWithNudgeInFlight.clear();
}

export function buildCommitNudgeMetadata(): string {
  return JSON.stringify({ kind: COMMIT_NUDGE_KIND });
}

/**
 * Persist a system callout and start a follow-up turn that tells the agent
 * to commit. Same shape as `triggerSessionShip`: the CLI prompt is not
 * stored as a user message.
 */
export function triggerUncommittedCommitNudge(
  args: TriggerUncommittedCommitNudgeArgs,
): TriggerUncommittedCommitNudgeResult {
  const { sessionId, session, agent, stmts, broadcast, activeProcesses, handleChat } = args;

  if (Number(session.ask_mode ?? 0) !== 0) {
    return { ok: false, status: 409, error: 'Ask mode is read-only', code: 'ask_mode' };
  }

  if (activeProcesses.has(sessionId) || sessionsWithNudgeInFlight.has(sessionId)) {
    return {
      ok: false,
      status: 409,
      error: 'Session is still streaming',
      code: 'session_streaming',
    };
  }

  if (!session.worktree_path) {
    return { ok: false, status: 400, error: 'Session has no worktree', code: 'no_worktree' };
  }

  const metadata = buildCommitNudgeMetadata();
  const msgId = uuidv4();
  try {
    stmts.addMessage.run(
      msgId,
      sessionId,
      'system',
      COMMIT_NUDGE_SYSTEM_MESSAGE,
      null,
      null,
      null,
      metadata,
      null,
      null,
      null,
    );
    stmts.touchSession.run(sessionId);
    const inserted =
      (stmts.getMessageById.get(msgId) as MessageRow | undefined) ??
      ({
        id: msgId,
        session_id: sessionId,
        role: 'system',
        content: COMMIT_NUDGE_SYSTEM_MESSAGE,
        engine: null,
        model: null,
        attachments: null,
        metadata,
        created_at: new Date().toISOString(),
      } satisfies MessageRow);
    broadcast({ type: 'message', message: inserted });
  } catch (err) {
    console.error(
      '[commit-nudge] Failed to persist system message:',
      err instanceof Error ? err.message : String(err),
    );
  }

  const cliPrompt = buildCommitNudgeCliPrompt({
    branch: args.branch,
    porcelain: args.porcelain,
  });

  sessionsWithNudgeInFlight.add(sessionId);
  void handleChat(null, {
    type: 'chat',
    agentId: session.agent_id,
    sessionId,
    content: cliPrompt,
    _skipUserMessagePersist: true,
  })
    .catch((err: Error) => {
      console.error(`[commit-nudge] handleChat failed for session ${sessionId}:`, err.message);
    })
    .finally(() => {
      sessionsWithNudgeInFlight.delete(sessionId);
    });

  return { ok: true };
}
