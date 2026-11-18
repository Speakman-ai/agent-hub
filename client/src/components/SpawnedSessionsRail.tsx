import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, Layers, RotateCcw, X } from 'lucide-react';
import { needsInputLabel, sessionStateMeta } from '@shared/utils/sessionState';
import {
  SESSION_FORWARD_BUILD_MODES,
  SESSION_FORWARD_MODE_OPTIONS,
} from '@shared/utils/extractForwardBlocks';
import { api } from '../utils/api';
import { deriveSessionState, sessionNeedsInputKind } from '../utils/deriveSessionState';
import { daysUntilPurge } from '../utils/time';
import {
  setOrchestrateLaunchSettings,
  useOrchestrateLaunchSettings,
} from '../utils/orchestrateLaunchSettings';
import {
  applySpawnedSessionEvent,
  reconcileSpawnedSnapshot,
  type SpawnedListState,
} from '@shared/utils/spawnedSessionEvents';
import SessionStateIcon from './SessionStateIcon';

export const SPAWNED_SESSION_WS_EVENT = 'agenthub:spawned-session-ws';

export interface SpawnedSessionRow {
  id: string;
  name: string;
  agent_id: string;
  state?: string | null;
  updated_at?: string;
  finalize_status?: string | null;
  needs_input?: string | null;
  needs_input_at?: number | null;
  last_turn_error?: string | null;
  spawned_from_session_id?: string | null;
}

export interface ArchivedSpawnedSession {
  id: string;
  name: string;
  agent_id: string;
  deleted_at: string;
}

export interface SpawnedSessionParent {
  id: string;
  name: string;
  agent_id: string;
  /** Set when this Orchestrate chat is itself a worker: the chat that started it. */
  up?: { id: string; name: string; agent_id: string } | null;
}

function subscribeSpawnedSessionEvents(cb: (data: any) => void): () => void {
  const handler = (ev: Event) => cb((ev as CustomEvent).detail);
  window.addEventListener(SPAWNED_SESSION_WS_EVENT, handler);
  return () => window.removeEventListener(SPAWNED_SESSION_WS_EVENT, handler);
}

const EMPTY_LIST: SpawnedListState<SpawnedSessionRow> = { sessions: [], archived: [] };

interface ScopedSpawnedList extends SpawnedListState<SpawnedSessionRow> {
  parentId: string;
  parent: SpawnedSessionParent | null;
}

function emptyScope(parentId: string): ScopedSpawnedList {
  return { parentId, parent: null, sessions: [], archived: [] };
}

function asSpawnedRow(session: any, parentId: string): SpawnedSessionRow | null {
  if (!session?.id || session.spawned_from_session_id !== parentId) return null;
  return {
    id: session.id,
    name: session.name || 'New session',
    agent_id: session.agent_id,
    state: session.state ?? null,
    updated_at: session.updated_at,
    finalize_status: session.finalize_status ?? null,
    needs_input: session.needs_input ?? null,
    needs_input_at: session.needs_input_at ?? null,
    last_turn_error: session.last_turn_error ?? null,
    spawned_from_session_id: session.spawned_from_session_id,
  };
}

/**
 * Slim list of sessions an Orchestrate chat has started. Clicking a row
 * opens that chat. Stays beside the transcript and does not take the
 * Changes / Preview slot.
 */
export default function SpawnedSessionsRail({
  parentSessionId,
  activeSessionId,
  agents,
  activeTaskSessionIds,
  finalizeStatusBySession,
  needsInputBySession,
  onOpenSession,
  onDeleteSession,
  onRestoreSession,
}: {
  parentSessionId: string;
  activeSessionId: string | null;
  agents?: Array<{ id: string; name?: string | null }>;
  /** Same live maps the left session list uses, so the icon stays in step. */
  activeTaskSessionIds?: Record<string, unknown>;
  finalizeStatusBySession?: Record<string, string>;
  needsInputBySession?: Record<string, { kind: string | null; at: number }>;
  onOpenSession: (session: SpawnedSessionRow) => void;
  /** Archive the worker. Return false to keep the row when the request fails. */
  onDeleteSession?: (session: SpawnedSessionRow) => Promise<boolean | void> | boolean | void;
  /** Put an archived worker back on the rail. Return false when the request fails. */
  onRestoreSession?: (session: ArchivedSpawnedSession) => Promise<boolean | void> | boolean | void;
}) {
  // Everything loaded is tagged with the parent it belongs to. A different
  // parent renders empty until its own GET lands, and late writes for the old
  // parent (GET, archive, restore) are dropped.
  const [scoped, setScoped] = useState<ScopedSpawnedList>(() => emptyScope(parentSessionId));
  const current = scoped.parentId === parentSessionId ? scoped : emptyScope(parentSessionId);
  const { parent, sessions, archived } = current;
  const parentIdRef = useRef(parentSessionId);
  parentIdRef.current = parentSessionId;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const updateScope = (parentId: string, update: (prev: ScopedSpawnedList) => ScopedSpawnedList) =>
    setScoped((prev) => (prev.parentId === parentId ? update(prev) : prev));
  // Events seen while the GET is in flight, replayed on its snapshot.
  const bufferedEventsRef = useRef<unknown[] | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // Below the lg breakpoint the rail is a drawer opened from an edge tab, since
  // workers are not on the left session list either.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const launch = useOrchestrateLaunchSettings(parentSessionId);

  useEffect(() => {
    let cancelled = false;
    bufferedEventsRef.current = [];
    const land = (
      parentRow: SpawnedSessionParent | null,
      snapshot: SpawnedListState<SpawnedSessionRow>,
    ) => {
      const events = bufferedEventsRef.current ?? [];
      bufferedEventsRef.current = null;
      setScoped({
        parentId: parentSessionId,
        parent: parentRow,
        ...reconcileSpawnedSnapshot<SpawnedSessionRow>(
          snapshot,
          events,
          parentSessionId,
          asSpawnedRow,
        ),
      });
    };
    api
      .getSpawnedSessions(parentSessionId)
      .then((body) => {
        if (cancelled) return;
        land(body.parent, { sessions: body.sessions, archived: body.archived ?? [] });
      })
      .catch(() => {
        if (cancelled) return;
        land(null, EMPTY_LIST);
      });
    return () => {
      cancelled = true;
      bufferedEventsRef.current = null;
    };
  }, [parentSessionId]);

  useEffect(() => {
    return subscribeSpawnedSessionEvents((data) => {
      bufferedEventsRef.current?.push(data);
      updateScope(parentSessionId, (prev) => ({
        ...prev,
        ...applySpawnedSessionEvent(prev, data, parentSessionId, asSpawnedRow),
      }));
    });
  }, [parentSessionId]);

  const deleteSession = async (session: SpawnedSessionRow) => {
    if (!onDeleteSession || deletingId) return;
    const parentId = parentSessionId;
    const parentRow = parent;
    setDeletingId(session.id);
    try {
      const removed = await onDeleteSession(session);
      if (removed === false) return;
      updateScope(parentId, (prev) => ({
        ...prev,
        ...applySpawnedSessionEvent(
          prev,
          { type: 'session_deleted', sessionId: session.id },
          parentId,
          asSpawnedRow,
        ),
      }));
      // Only step back to the parent when the user is still on this worker
      // under this parent; they may have moved on while the archive ran.
      if (
        parentRow &&
        parentIdRef.current === parentId &&
        activeSessionIdRef.current === session.id
      ) {
        onOpenSession({ id: parentRow.id, name: parentRow.name, agent_id: parentRow.agent_id });
      }
    } finally {
      setDeletingId(null);
    }
  };

  const restoreSession = async (session: ArchivedSpawnedSession) => {
    if (!onRestoreSession || restoringId) return;
    const parentId = parentSessionId;
    setRestoringId(session.id);
    try {
      const restored = await onRestoreSession(session);
      if (restored === false) return;
      updateScope(parentId, (prev) => ({
        ...prev,
        archived: prev.archived.filter((row) => row.id !== session.id),
        sessions: prev.sessions.some((row) => row.id === session.id)
          ? prev.sessions
          : [
              {
                id: session.id,
                name: session.name,
                agent_id: session.agent_id,
                state: 'waiting_for_user_input',
              },
              ...prev.sessions,
            ],
      }));
    } finally {
      setRestoringId(null);
    }
  };

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const openSession = (session: SpawnedSessionRow) => {
    setDrawerOpen(false);
    onOpenSession(session);
  };

  const viewingWorker = activeSessionId != null && activeSessionId !== parentSessionId;
  // On a worker, step back to this list's chat. On the list's own chat, step up
  // to the chat that started it when it is a nested Orchestrate chat.
  const backTarget = viewingWorker ? parent : (parent?.up ?? null);
  const agentName = (agentId: string) => {
    if (!parent || agentId === parent.agent_id) return null;
    return agents?.find((agent) => agent.id === agentId)?.name || agentId;
  };

  return (
    <>
      <button
        type="button"
        data-testid="spawned-sessions-drawer-toggle"
        aria-label={`Spawned sessions (${sessions.length})`}
        aria-expanded={drawerOpen}
        aria-controls="spawned-sessions-rail"
        onClick={() => setDrawerOpen(true)}
        className={`lg:hidden fixed right-0 top-1/2 z-30 -translate-y-1/2 flex-col items-center gap-1 rounded-l-md border border-r-0 border-gray-700 bg-gray-900 px-1.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-300 shadow-lg hover:bg-gray-800 ${drawerOpen ? 'hidden' : 'flex'}`}
      >
        <Layers size={14} aria-hidden />
        <span>{sessions.length}</span>
      </button>
      {drawerOpen ? (
        <div
          data-testid="spawned-sessions-drawer-backdrop"
          aria-hidden
          onClick={() => setDrawerOpen(false)}
          className="lg:hidden fixed inset-0 z-30 bg-black/50"
        />
      ) : null}
      <aside
        id="spawned-sessions-rail"
        data-testid="spawned-sessions-rail"
        data-drawer-open={drawerOpen ? 'true' : undefined}
        aria-label="Spawned sessions"
        className={`${
          drawerOpen
            ? 'fixed inset-y-0 right-0 z-40 flex w-[280px] max-w-[85vw] shadow-2xl'
            : 'hidden'
        } lg:static lg:z-auto lg:flex lg:w-[220px] lg:max-w-none lg:shadow-none shrink-0 flex-col min-h-0 border-l border-gray-800 bg-gray-950`}
      >
        <div className="border-b border-gray-800 px-3 py-2">
          <div className="flex items-center text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <span className="flex-1">Sessions</span>
            <button
              type="button"
              data-testid="spawned-sessions-drawer-close"
              aria-label="Close spawned sessions"
              onClick={() => setDrawerOpen(false)}
              className="lg:hidden rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          <label className="mt-2 block text-[10px] uppercase tracking-wide text-gray-500">
            Default build
            <select
              data-testid="orchestrate-default-build"
              aria-label="Default build mode"
              value={launch.mode}
              onChange={(event) =>
                setOrchestrateLaunchSettings(parentSessionId, {
                  mode: event.target.value as (typeof SESSION_FORWARD_BUILD_MODES)[number],
                })
              }
              className="mt-1 w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs normal-case tracking-normal text-gray-100"
            >
              {SESSION_FORWARD_MODE_OPTIONS.filter((option) =>
                SESSION_FORWARD_BUILD_MODES.includes(option.value),
              ).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-2 flex items-center gap-2 text-xs normal-case tracking-normal text-gray-300">
            <input
              type="checkbox"
              data-testid="orchestrate-auto-start"
              checked={launch.autoStart}
              onChange={(event) =>
                setOrchestrateLaunchSettings(parentSessionId, { autoStart: event.target.checked })
              }
            />
            Auto start
          </label>
        </div>
        {backTarget ? (
          <button
            type="button"
            data-testid="spawned-sessions-back"
            onClick={() =>
              openSession({
                id: backTarget.id,
                name: backTarget.name,
                agent_id: backTarget.agent_id,
              })
            }
            className="flex items-center gap-1.5 px-3 py-2 text-left text-xs text-sky-300 hover:bg-gray-900 border-b border-gray-800"
          >
            <ArrowLeft size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{backTarget.name || 'Back to chat'}</span>
          </button>
        ) : null}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="px-3 py-3 text-xs leading-4 text-gray-500">
              Spawned sessions will show up here.
            </p>
          ) : (
            <ul>
              {sessions.map((session) => {
                const selected = session.id === activeSessionId;
                const otherAgent = agentName(session.agent_id);
                const signals = {
                  activeTaskSessionIds,
                  finalizeStatusBySession,
                  needsInputBySession,
                };
                const sessionState = deriveSessionState(session, signals);
                const statusLabel =
                  sessionState === 'needs_input'
                    ? needsInputLabel(sessionNeedsInputKind(session, signals))
                    : sessionStateMeta(sessionState).label;
                return (
                  <li
                    key={session.id}
                    className={`flex items-start hover:bg-gray-900 ${selected ? 'bg-gray-900' : ''}`}
                  >
                    <button
                      type="button"
                      data-testid={`spawned-session-${session.id}`}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() =>
                        openSession({ ...session, spawned_from_session_id: parentSessionId })
                      }
                      className="flex min-w-0 flex-1 items-start gap-1.5 px-3 py-2 text-left"
                    >
                      <SessionStateIcon
                        state={sessionState}
                        size={12}
                        className="mt-0.5"
                        label={statusLabel}
                        testId={`spawned-session-state-${session.id}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-gray-200">
                          {session.name || 'New session'}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500">
                          <span
                            className="truncate"
                            data-testid={`spawned-session-status-${session.id}`}
                          >
                            {statusLabel}
                          </span>
                          {otherAgent ? <span className="truncate">· {otherAgent}</span> : null}
                        </span>
                      </span>
                    </button>
                    {onDeleteSession ? (
                      <button
                        type="button"
                        data-testid={`spawned-session-delete-${session.id}`}
                        title="Delete session"
                        aria-label={`Delete ${session.name || 'session'}`}
                        disabled={deletingId === session.id}
                        onClick={() => void deleteSession(session)}
                        className="mr-1 mt-1.5 shrink-0 rounded p-1 text-xs text-gray-600 hover:bg-gray-800 hover:text-red-400 disabled:opacity-50"
                      >
                        {deletingId === session.id ? '⟳' : '✕'}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {archived.length > 0 && (
            <div
              className="mt-2 border-t border-gray-800 px-1 pt-1"
              data-testid="spawned-archived-section"
            >
              <button
                type="button"
                data-testid="spawned-archived-toggle"
                onClick={() => setArchivedOpen((open) => !open)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] uppercase tracking-wider text-gray-600 hover:text-gray-400"
              >
                <Archive size={10} />
                <span className="flex-1">Archived ({archived.length})</span>
                <span>{archivedOpen ? '▾' : '▸'}</span>
              </button>
              {archivedOpen &&
                archived.map((session) => {
                  const purge = daysUntilPurge(session.deleted_at, 1);
                  const urgent = purge != null && purge.daysLeft <= 1;
                  return (
                    <div
                      key={session.id}
                      data-testid={`spawned-archived-${session.id}`}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{session.name || 'New session'}</div>
                        {purge && (
                          <div
                            className={`text-[10px] ${urgent ? 'text-amber-400' : 'text-gray-600'}`}
                          >
                            {purge.label}
                          </div>
                        )}
                      </div>
                      {onRestoreSession ? (
                        <button
                          type="button"
                          data-testid={`spawned-session-restore-${session.id}`}
                          title="Restore session"
                          disabled={restoringId === session.id}
                          onClick={() => void restoreSession(session)}
                          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:text-emerald-400 disabled:opacity-40"
                        >
                          {restoringId === session.id ? (
                            <span className="inline-block animate-spin">⟳</span>
                          ) : (
                            <RotateCcw size={11} />
                          )}
                          Restore
                        </button>
                      ) : null}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
