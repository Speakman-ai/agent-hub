/**
 * QA run sessions are plumbing, like the docs agent's `[Wiki]` sessions: the
 * user reads the outcome on the QA page, not in a chat. They are created
 * hidden (no sidebar row, no inbox or push) and archived once the run is over.
 *
 * The archived row is kept past the 24h purge while a run references it,
 * because the run's screenshots are artifacts of that session.
 */
import type { BroadcastFn, QaRunRow, SessionRow, Stmts } from './types.js';

const TERMINAL_RUN_STATUSES = new Set(['passed', 'failed', 'cancelled']);

/**
 * Archive a QA run session whose run has finished. No-op for any session that
 * is not a hidden QA run session, is already archived, or whose run is still
 * queued or running (the agent may be woken to continue it). Never throws:
 * chat turn teardown must not fail on cleanup.
 */
export function maybeArchiveQaRunSession(
  deps: { stmts: Stmts; broadcast?: BroadcastFn },
  args: { sessionId: string },
): { archived: boolean } {
  try {
    const session = deps.stmts.getSession.get(args.sessionId) as SessionRow | undefined;
    if (!session || session.deleted_at || session.hidden !== 1) return { archived: false };
    if (session.session_mode !== 'qa') return { archived: false };
    const run = deps.stmts.getQaRunBySession.get(args.sessionId) as QaRunRow | undefined;
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) return { archived: false };
    deps.stmts.softDeleteSession.run(args.sessionId);
    deps.broadcast?.({ type: 'session_deleted', sessionId: args.sessionId });
    return { archived: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[qa] run session archival failed for ${args.sessionId}: ${msg}`);
    return { archived: false };
  }
}
