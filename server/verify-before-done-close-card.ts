import type {
  CloseCardTask,
  CardAutoCloseOutcome,
  CardAutoCloseFailureReason,
} from './card-auto-close.js';
import { handleCardAutoClose } from './card-auto-close.js';
import { runProjectVerifyBeforeDoneCommands } from './auto-git.js';
import {
  appendVerifyOutputToMarkdownBody,
  buildVerifyFailureMarkdownBody,
} from './verify-before-done-markdown.js';
import type { Project, Stmts, BroadcastFn } from './types.js';

const POST_VERIFY_MESSAGES: Record<
  CardAutoCloseFailureReason,
  { content: string; cardClose: string }
> = {
  no_linked_card: {
    content:
      '**Pre-done verification passed**, but no kanban card is linked to this session, so nothing was moved to Done.',
    cardClose: 'no_linked_card',
  },
  card_lookup_failed: {
    content:
      '**Pre-done verification passed**, but the server could not look up the linked kanban card (database error). The card was **not** moved to Done—check server logs.',
    cardClose: 'card_lookup_failed',
  },
  column_lookup_failed: {
    content:
      '**Pre-done verification passed**, but loading board columns failed, so the card could **not** be moved to Done—check server logs.',
    cardClose: 'column_lookup_failed',
  },
  no_done_column: {
    content:
      '**Pre-done verification passed**, but this board has no usable **Done** column, so the card was **not** moved.',
    cardClose: 'no_done_column',
  },
  move_failed: {
    content:
      '**Pre-done verification passed**, but moving the linked card to **Done** failed (database error). Check server logs.',
    cardClose: 'move_failed',
  },
};

export interface BuildPostVerifyCardCloseOptions {
  /** Stdout/stderr captured during verify; appended for durable audit trail. */
  verifyTranscript?: string;
}

/** User-visible system copy after verify succeeds (commands green). */
export function buildPostVerifyCardCloseSystemMessage(
  outcome: CardAutoCloseOutcome,
  options?: BuildPostVerifyCardCloseOptions,
): {
  content: string;
  meta: Record<string, unknown>;
} {
  const attachTranscript = (content: string): string => {
    const t = options?.verifyTranscript;
    return t ? appendVerifyOutputToMarkdownBody(content, t) : content;
  };

  if (outcome.ok) {
    const { cardId, previousColumnId, doneColumnId } = outcome.result;
    const alreadyInDone = previousColumnId === doneColumnId;
    if (alreadyInDone) {
      return {
        content: attachTranscript(
          '**Pre-done verification passed.** The linked kanban card was **already in Done**; no column move was required. The server **attempts** an audit comment on the card (best-effort; it may be missing if comment insert failed).',
        ),
        meta: {
          kind: 'verify_before_done',
          outcome: 'passed',
          cardClose: 'already_in_done',
          cardId,
        },
      };
    }
    return {
      content: attachTranscript(
        '**Pre-done verification passed.** The linked kanban card was moved to Done.',
      ),
      meta: {
        kind: 'verify_before_done',
        outcome: 'passed',
        cardClose: 'moved',
        cardId,
      },
    };
  }
  const row = POST_VERIFY_MESSAGES[outcome.reason];
  return {
    content: attachTranscript(row.content),
    meta: {
      kind: 'verify_before_done',
      outcome: 'verify_passed_card_close_failed',
      cardClose: row.cardClose,
    },
  };
}

export type RunVerifyFn = (
  project: Project,
  cwd: string,
  onChunk?: (chunk: string) => void,
) => Promise<void>;

/**
 * Runs configured verify commands, then `handleCardAutoClose`. Streams
 * `done_verify_log` / `done_verify_log_done` and persists a system receipt.
 * Caller must ensure `getProjectVerifyBeforeDoneCommands(project)` is non-empty
 * and `effectiveCwd` exists on disk.
 */
export async function runVerifiedCloseCardFlow(opts: {
  sessionId: string;
  closeTask: CloseCardTask;
  project: Project;
  effectiveCwd: string;
  projectId: string;
  author: string;
  stmts: Stmts;
  broadcast: BroadcastFn;
  persistSystemMessage: (sessionId: string, content: string, meta: Record<string, unknown>) => void;
  runVerifyFn?: RunVerifyFn;
}): Promise<void> {
  const runVerifyFn = opts.runVerifyFn ?? runProjectVerifyBeforeDoneCommands;

  opts.broadcast({ type: 'done_verify_log_done', sessionId: opts.sessionId });
  let accumulated = '';
  const onChunk = (chunk: string) => {
    accumulated += chunk;
    opts.broadcast({ type: 'done_verify_log', sessionId: opts.sessionId, text: chunk });
  };

  try {
    onChunk(
      '## Pre-done verification\n\nRunning configured `verifyBeforeDoneCommands` before moving the linked card to **Done**.\n',
    );
    await runVerifyFn(opts.project, opts.effectiveCwd, onChunk);
    opts.broadcast({ type: 'done_verify_log_done', sessionId: opts.sessionId });
    const outcome = handleCardAutoClose(opts.sessionId, opts.closeTask, {
      stmts: opts.stmts,
      broadcast: opts.broadcast,
      projectId: opts.projectId,
      author: opts.author,
    });
    const { content, meta } = buildPostVerifyCardCloseSystemMessage(outcome, {
      verifyTranscript: accumulated,
    });
    opts.persistSystemMessage(opts.sessionId, content, meta);
  } catch (verifyErr: unknown) {
    opts.broadcast({ type: 'done_verify_log_done', sessionId: opts.sessionId });
    const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    opts.persistSystemMessage(opts.sessionId, buildVerifyFailureMarkdownBody(errMsg, accumulated), {
      kind: 'verify_before_done',
      outcome: 'failed',
      error: errMsg,
    });
  }
}
