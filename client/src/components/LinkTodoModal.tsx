import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import { api, type UserTodoWire } from '../utils/api';
import type { ProjectWire } from '@shared/types';
import {
  LINK_TARGET_TYPES,
  LINK_TARGET_LABELS,
  DEFAULT_LINK_TARGET_TYPE,
  agentsForProject,
  buildLinkPayload,
  canSubmitLink,
  filterLinkOptions,
  normalizeLinkOptions,
  type LinkOption,
  type LinkTargetType,
} from '@shared/utils/linkTodo';

/**
 * Link-to-existing picker (spec TODO-TO-TICKET LINK op): associate a personal
 * todo with an ALREADY-EXISTING card, epic, or session — no entity is created
 * (that is the promote op). The todo and the target stay distinct, joined by
 * the polymorphic link the server sets.
 *
 * A card / epic target is project-scoped: pick a project, then the card / epic
 * off that board. A session target is browsed project → agent → session (the
 * server gates it by session ownership, not project). The write payload and the
 * submit gate come from the shared `linkTodo` helpers so web + mobile agree.
 */

export default function LinkTodoModal({
  todo,
  onClose,
  onLinked,
}: {
  todo: UserTodoWire;
  onClose: () => void;
  onLinked?: (result: { todo: UserTodoWire }) => void;
}) {
  const [targetType, setTargetType] = useState<LinkTargetType>(DEFAULT_LINK_TARGET_TYPE);
  const [projects, setProjects] = useState<ProjectWire[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  // Board-derived options for card/epic targets.
  const [cards, setCards] = useState<LinkOption[]>([]);
  const [epics, setEpics] = useState<LinkOption[]>([]);
  // Session-target browse chain: project → agent → session.
  const [agents, setAgents] = useState<LinkOption[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [sessions, setSessions] = useState<LinkOption[]>([]);

  const [targetId, setTargetId] = useState<string>('');
  const [filter, setFilter] = useState('');

  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingList, setLoadingList] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingProjects(true);
    api
      .getProjects()
      .then((list) => {
        if (cancelled) return;
        const rows = Array.isArray(list) ? list : [];
        setProjects(rows);
        if (rows.length) setProjectId(String(rows[0].id));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load a project's board for card/epic targets. Cards come from the flat
  // `board.cards` (named by `title`), epics from `board.epics` (named by `name`).
  const loadBoard = useCallback((pid: string) => {
    let cancelled = false;
    setLoadingList(true);
    setCards([]);
    setEpics([]);
    api
      .getBoard(pid)
      .then((board: any) => {
        if (cancelled) return;
        setCards(normalizeLinkOptions(board?.cards, ['title', 'name']));
        setEpics(normalizeLinkOptions(board?.epics, ['name', 'title']));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load board');
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the project's agents for the session browse chain.
  const loadAgents = useCallback((pid: string) => {
    let cancelled = false;
    setLoadingList(true);
    setAgents([]);
    setSessions([]);
    setAgentId('');
    api
      .getAgents()
      .then((list: any) => {
        if (cancelled) return;
        setAgents(agentsForProject(list, pid));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load agents');
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever the project or target type changes, reset the selected target and
  // (re)load the appropriate option source.
  useEffect(() => {
    setTargetId('');
    setFilter('');
    setError(null);
    if (!projectId) return;
    if (targetType === 'session') {
      return loadAgents(projectId);
    }
    return loadBoard(projectId);
  }, [projectId, targetType, loadBoard, loadAgents]);

  // Load an agent's sessions once one is picked (session target only).
  useEffect(() => {
    if (targetType !== 'session' || !agentId) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    setLoadingList(true);
    setSessions([]);
    setTargetId('');
    api
      .getSessions(agentId)
      .then((list: any) => {
        if (cancelled) return;
        setSessions(normalizeLinkOptions(list, ['name']));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load sessions');
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, targetType]);

  const options = useMemo<LinkOption[]>(() => {
    const source = targetType === 'card' ? cards : targetType === 'epic' ? epics : sessions;
    return filterLinkOptions(source, filter);
  }, [targetType, cards, epics, sessions, filter]);

  const canSubmit = canSubmitLink({
    targetType,
    targetId,
    projectId,
    submitting,
    loading: loadingList,
  });

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.linkTodo(
        todo.id,
        buildLinkPayload({ targetType, targetId, projectId }),
      );
      setDone(true);
      onLinked?.(result);
      window.setTimeout(() => onClose(), 700);
    } catch (err: any) {
      setError(err?.message || 'Failed to link todo');
      setSubmitting(false);
    }
  };

  const listEmptyLabel =
    targetType === 'session'
      ? agentId
        ? 'No sessions for this agent'
        : 'Pick an agent first'
      : `No ${targetType === 'card' ? 'cards' : 'epics'} on this board`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="link-todo-modal"
    >
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Link to existing</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {error && (
            <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="text-sm text-gray-300">
            <span className="text-gray-500">Todo:</span> {todo.title}
          </div>

          {/* Target type toggle */}
          <div>
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400">
              Link to
            </span>
            <div className="flex gap-2" role="group" aria-label="Link target type">
              {LINK_TARGET_TYPES.map((t) => {
                const active = t === targetType;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTargetType(t)}
                    data-testid={`link-type-${t}`}
                    aria-pressed={active}
                    className={`flex-1 rounded border px-3 py-2 text-sm font-medium ${
                      active
                        ? 'border-blue-500 bg-blue-600 text-white'
                        : 'border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700'
                    }`}
                  >
                    {LINK_TARGET_LABELS[t]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Project (scopes cards/epics, or which agents' sessions to browse) */}
          <div>
            <label
              htmlFor="link-project"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Project
            </label>
            <select
              id="link-project"
              data-testid="link-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={loadingProjects || !projects.length}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
            >
              {loadingProjects ? (
                <option value="">Loading projects…</option>
              ) : !projects.length ? (
                <option value="">No projects available</option>
              ) : (
                projects.map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {p.name}
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Agent selector — session target only */}
          {targetType === 'session' && (
            <div>
              <label
                htmlFor="link-agent"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
              >
                Agent
              </label>
              <select
                id="link-agent"
                data-testid="link-agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={!agents.length}
                className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
              >
                <option value="">{agents.length ? 'Select an agent…' : 'No agents'}</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Target list (cards / epics / sessions) with a search filter */}
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-400">
                {LINK_TARGET_LABELS[targetType]}
              </span>
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                aria-label="Filter targets"
                data-testid="link-filter"
                className="w-40 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div
              data-testid="link-options"
              className="max-h-56 overflow-y-auto rounded border border-gray-800 bg-gray-950"
            >
              {loadingList ? (
                <div className="px-3 py-6 text-center text-sm text-gray-500">Loading…</div>
              ) : !options.length ? (
                <div className="px-3 py-6 text-center text-sm text-gray-500">{listEmptyLabel}</div>
              ) : (
                <ul className="divide-y divide-gray-800">
                  {options.map((o) => {
                    const active = o.id === targetId;
                    return (
                      <li key={o.id}>
                        <button
                          type="button"
                          onClick={() => setTargetId(o.id)}
                          data-testid={`link-option-${o.id}`}
                          aria-pressed={active}
                          className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                            active ? 'bg-blue-600/20 text-white' : 'text-gray-300 hover:bg-gray-800'
                          }`}
                        >
                          <span className="truncate">{o.name}</span>
                          {active && <Check size={14} className="flex-shrink-0 text-blue-400" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            data-testid="link-submit"
            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : done ? (
              <Check size={14} />
            ) : null}
            {done ? 'Linked' : 'Link'}
          </button>
        </div>
      </div>
    </div>
  );
}
