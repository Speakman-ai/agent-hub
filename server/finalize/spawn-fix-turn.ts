import type { ChatMessage, Stmts } from '../types.js';

/** User turn that kicks off the originating agent after a §7 fix dispatch. */
export const FINALIZE_FIX_TURN_USER_PROMPT =
  'Finalize Code Changes needs fixes — read the system message above (reviewer notes and/or failed CI output). Address every blocking item, commit on this branch, and end your turn. The pipeline re-runs automatically when you finish.';

export interface SpawnFinalizeFixTurnDeps {
  stmts: Pick<Stmts, 'getSession'>;
  findAgent: (agentId: string) => { agent: { id: string } } | null;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  log?: (msg: string) => void;
}

export type SpawnFinalizeFixTurnFn = (args: {
  sessionId: string;
  body: string;
}) => Promise<{ spawned: boolean }>;

/**
 * Spawn the originating session agent after a fix-dispatch system message
 * lands. Mirrors `dispatchReviewFeedback` in webhooks — without this the
 * orchestrator waits forever on turn-end.
 */
export function createSpawnFinalizeFixTurn(deps: SpawnFinalizeFixTurnDeps): SpawnFinalizeFixTurnFn {
  const log = deps.log ?? ((msg: string) => console.warn(msg));

  return async function spawnFinalizeFixTurn(args: {
    sessionId: string;
    body: string;
  }): Promise<{ spawned: boolean }> {
    const { sessionId } = args;
    const session = deps.stmts.getSession.get(sessionId) as { agent_id?: string } | undefined;
    if (!session?.agent_id) {
      log(`[finalize-fix-dispatch] spawn skipped — no session row for ${sessionId}`);
      return { spawned: false };
    }
    const lookup = deps.findAgent(session.agent_id);
    if (!lookup) {
      log(
        `[finalize-fix-dispatch] spawn skipped — agent ${session.agent_id} not found for session ${sessionId}`,
      );
      return { spawned: false };
    }

    try {
      await deps.handleChat(null, {
        type: 'chat',
        agentId: session.agent_id,
        sessionId,
        content: FINALIZE_FIX_TURN_USER_PROMPT,
        _skipUserMessagePersist: true,
      });
      return { spawned: true };
    } catch (err) {
      log(
        `[finalize-fix-dispatch] handleChat failed for session=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { spawned: false };
    }
  };
}
