/**
 * Live updates for an Orchestrate parent's worker list (web rail, mobile
 * sheet). Pure, so events that arrive while the initial GET is in flight can
 * be replayed on top of its snapshot instead of being overwritten by it.
 */
export interface SpawnedRowBase {
  id: string;
  name: string;
  agent_id: string;
  state?: string | null;
}

export interface SpawnedArchivedRow {
  id: string;
  name: string;
  agent_id: string;
  deleted_at: string;
}

export interface SpawnedListState<R extends SpawnedRowBase> {
  sessions: R[];
  archived: SpawnedArchivedRow[];
}

export function applySpawnedSessionEvent<R extends SpawnedRowBase>(
  state: SpawnedListState<R>,
  data: any,
  parentId: string,
  asRow: (session: any, parentId: string) => R | null,
  now: () => string = () => new Date().toISOString(),
): SpawnedListState<R> {
  if (!data || typeof data !== 'object') return state;
  if (data.type === 'session_deleted' && typeof data.sessionId === 'string') {
    const row = state.sessions.find((session) => session.id === data.sessionId);
    if (!row) return state;
    return {
      sessions: state.sessions.filter((session) => session.id !== row.id),
      archived: state.archived.some((session) => session.id === row.id)
        ? state.archived
        : [
            { id: row.id, name: row.name, agent_id: row.agent_id, deleted_at: now() },
            ...state.archived,
          ],
    };
  }
  if (data.type === 'session_restored') {
    const restoredId = typeof data.sessionId === 'string' ? data.sessionId : data.session?.id;
    if (typeof restoredId !== 'string') return state;
    const archived = state.archived.filter((session) => session.id !== restoredId);
    const created = asRow(data.session, parentId);
    const sessions =
      created && !state.sessions.some((session) => session.id === created.id)
        ? [created, ...state.sessions]
        : state.sessions;
    return { sessions, archived };
  }
  if (data.type === 'session_state' && typeof data.sessionId === 'string') {
    if (!state.sessions.some((row) => row.id === data.sessionId)) return state;
    return {
      ...state,
      sessions: state.sessions.map((row) =>
        row.id === data.sessionId ? { ...row, state: data.state } : row,
      ),
    };
  }
  const created = asRow(data.session, parentId);
  if (!created || state.sessions.some((row) => row.id === created.id)) return state;
  return { ...state, sessions: [created, ...state.sessions] };
}

/** Snapshot from the GET, with the events seen while it was in flight applied on top. */
export function reconcileSpawnedSnapshot<R extends SpawnedRowBase>(
  snapshot: SpawnedListState<R>,
  events: readonly unknown[],
  parentId: string,
  asRow: (session: any, parentId: string) => R | null,
): SpawnedListState<R> {
  return events.reduce<SpawnedListState<R>>(
    (state, event) => applySpawnedSessionEvent(state, event, parentId, asRow),
    snapshot,
  );
}
