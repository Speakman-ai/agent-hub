import type { ActiveTaskRow, BroadcastFn, SessionRow, Stmts } from './types.js';
import { activeDelegationSessions, delegationSessionUiMeta } from './delegation-state.js';

export interface ActiveTaskSnapshot {
  sessionId: string;
  messageId: string;
  agentId: string;
  engine: string;
  model: string | null;
  prompt: string;
  content: string;
  startedAt: string;
}

/**
 * Active CLI tasks from `active_tasks` plus synthetic rows for sessions in an
 * open delegation window (sub-agents running; lead CLI has exited).
 *
 * Propagates errors from `getAllActiveTasks` so `GET /api/active-tasks` can
 * return 500 on DB failure. Delegation overlay enrichment is best-effort per
 * session (a bad overlay row is skipped without discarding the primary list).
 */
export function buildActiveTasksSnapshot(stmts: Stmts): ActiveTaskSnapshot[] {
  const fromDb = (stmts.getAllActiveTasks.all() as ActiveTaskRow[]).map((t) => ({
    sessionId: t.session_id,
    messageId: t.message_id,
    agentId: t.agent_id,
    engine: t.engine,
    model: t.model,
    prompt: t.prompt,
    content: t.streamed_output || '',
    startedAt: t.started_at,
  }));
  const seen = new Set(fromDb.map((r) => r.sessionId));
  for (const sessionId of activeDelegationSessions) {
    if (seen.has(sessionId)) continue;
    // Only after a real `delegation_start` (skip empty-validTasks edge case).
    if (!delegationSessionUiMeta.has(sessionId)) continue;
    try {
      const meta = delegationSessionUiMeta.get(sessionId);
      const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session || !meta) continue;
      fromDb.push({
        sessionId,
        messageId: meta.parentMessageId || `delegation:${sessionId}`,
        agentId: session.agent_id,
        engine: session.engine || 'claude-code',
        model: session.model ?? null,
        prompt: '[delegation]',
        content: '',
        startedAt: meta.startedAt,
      });
    } catch (err) {
      console.warn(
        '[active-tasks] delegation overlay skipped for session',
        sessionId,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return fromDb;
}

/**
 * WebSocket / hot-path helper: never throws. On DB failure returns `[]` and
 * logs so clients still receive `{ type: 'active-tasks-snapshot', tasks: [] }`
 * on connect (matches pre-refactor `activeTasksSnapshot()` behavior). REST
 * uses {@link buildActiveTasksSnapshot} so failures surface as 500.
 */
export function buildActiveTasksSnapshotLenient(stmts: Stmts): ActiveTaskSnapshot[] {
  try {
    return buildActiveTasksSnapshot(stmts);
  } catch (err) {
    console.error(
      '[active-tasks] snapshot failed (lenient empty fallback):',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

export function broadcastActiveTasksSnapshot(stmts: Stmts, broadcast: BroadcastFn): void {
  try {
    broadcast({ type: 'active-tasks-snapshot', tasks: buildActiveTasksSnapshot(stmts) });
  } catch (err) {
    console.error(
      '[active-tasks] broadcast snapshot failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
