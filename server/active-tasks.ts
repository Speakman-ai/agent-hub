import type { ActiveTaskRow, BroadcastFn, Stmts } from './types.js';

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
 * Propagates errors from `getAllActiveTasks` so `GET /api/active-tasks` can
 * return 500 on DB failure.
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
