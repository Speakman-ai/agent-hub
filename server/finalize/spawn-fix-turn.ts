import type { ChatMessage, Stmts } from '../types.js';

/**
 * Fallback turn content, used ONLY when the §7 dispatch body is
 * unexpectedly empty (the dispatcher already refuses to dispatch an empty
 * body, so this is defensive).
 *
 * The normal path sends the full §7 body (reviewer notes + failed-step
 * output + trailer) as the CLI turn content — see {@link composeFixTurnContent}.
 * This prompt deliberately no longer says "read the system message above":
 * that system row is persisted to Agent Hub's DB and rendered in the web
 * UI, but for a **resumed** CLI session it is NOT part of the engine's
 * conversation context (`needsHistoryBootstrap` is false for resumed
 * sessions in `chat.ts`). Pointing the agent at a message it cannot see is
 * exactly why fix turns flailed hunting for reviewer notes.
 */
export const FINALIZE_FIX_TURN_USER_PROMPT =
  'Finalize Code Changes needs fixes — address every blocking item from the reviewer notes and/or failed CI output, commit on this branch, and end your turn. The pipeline re-runs automatically when you finish.';

/**
 * Build the CLI turn content for a fix dispatch. The §7 `body` (header +
 * reviewer notes + failed-step excerpt + trailer) is self-contained and is
 * sent verbatim so the agent receives the notes directly, regardless of
 * engine or whether the session is resumed. Falls back to the generic
 * prompt only if the body is empty/blank.
 */
export function composeFixTurnContent(body: string | null | undefined): string {
  const trimmed = (body ?? '').trim();
  return trimmed.length > 0 ? trimmed : FINALIZE_FIX_TURN_USER_PROMPT;
}

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
        // Send the full §7 body (reviewer notes + failed-step output) as the
        // turn content so the agent sees the notes in its own CLI context.
        // `_skipUserMessagePersist` keeps it out of the transcript/UI — the
        // dispatcher already inserted the same body as a `system` row.
        content: composeFixTurnContent(args.body),
        _skipUserMessagePersist: true,
        _finalizeInternal: true,
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
