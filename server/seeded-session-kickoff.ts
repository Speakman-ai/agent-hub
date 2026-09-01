/**
 * Kick off a newly created session's first user turn and wait until that
 * turn is *accepted* (persisted or queued), not until the CLI finishes.
 *
 * Wizard spawn routes used to `createSession` + fire-and-forget `handleChat`
 * + 201. That reports success for a row whose seed never landed, and a retry
 * then creates a second empty session. `handleChat` already exposes
 * `_onUserMessagePersisted` for this: true once the user message is stored,
 * false if the turn is dropped before that.
 *
 * After acceptance the chat promise keeps running in the background. The
 * caller 201s and deep-links; CLI spawn failures after persist surface in
 * the session itself rather than as an empty `[Voting Setup]` row.
 */
import type { ChatMessage, Stmts } from './types.js';

export class SeededTurnNotAcceptedError extends Error {
  constructor(message = 'Seeded turn was not accepted') {
    super(message);
    this.name = 'SeededTurnNotAcceptedError';
  }
}

export interface KickoffSeededTurnArgs {
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  agentId: string;
  sessionId: string;
  content: string;
  /** Invoked if handleChat rejects *after* the seed was accepted. */
  onBackgroundError?: (err: unknown) => void;
}

/**
 * Dispatch `handleChat` and resolve once the first user turn is accepted.
 * Rejects with {@link SeededTurnNotAcceptedError} (or the underlying error)
 * if the turn is dropped or throws before persist. Does not wait for the CLI.
 */
export function kickoffSeededTurn(args: KickoffSeededTurnArgs): Promise<void> {
  const { handleChat, agentId, sessionId, content, onBackgroundError } = args;

  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new SeededTurnNotAcceptedError(String(err)));
    };

    let chatPromise: Promise<void>;
    try {
      chatPromise = handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content,
        _onUserMessagePersisted: (accepted) => {
          if (accepted) succeed();
          else fail(new SeededTurnNotAcceptedError());
        },
      });
    } catch (err) {
      fail(err);
      return;
    }

    void Promise.resolve(chatPromise).then(
      () => {
        if (!settled) fail(new SeededTurnNotAcceptedError());
      },
      (err: unknown) => {
        if (!settled) {
          fail(err);
          return;
        }
        onBackgroundError?.(err);
      },
    );
  });
}

/**
 * Drop a session whose seed never landed so a retry cannot stack empty rows.
 * Callers must not have broadcast `session_created` yet.
 */
export function abandonUnseededSession(
  stmts: Pick<Stmts, 'deleteSession'>,
  sessionId: string,
): void {
  try {
    stmts.deleteSession.run(sessionId);
  } catch (cleanupErr) {
    console.error(
      `[seeded-session] failed to delete unseeded session ${sessionId}:`,
      cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
    );
  }
}
