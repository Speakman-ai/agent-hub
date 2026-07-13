import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import { api, type UserTodoWire, type TodoPriority } from '../utils/api';
import type { ProjectWire } from '@shared/types';
import {
  PROMOTE_PRIORITY_OPTIONS,
  buildPromotePayload,
  canSubmitPromote,
  defaultPromoteOptionId,
  defaultPromotePriority,
  normalizePromoteOptions,
  type PromoteOption,
} from '@shared/utils/promoteTodo';

/**
 * Promote-to-ticket picker (spec TODO-TO-TICKET PROMOTE op): turn a personal
 * todo into a real kanban card on a chosen project board. The todo and the card
 * stay distinct entities joined by a link — the server creates the card, stamps
 * its provenance back to the todo, and links the todo to it.
 *
 * This modal only collects the destination (project + column + optional epic)
 * and the card priority (defaulting to the todo's own priority so a promote maps
 * 1:1). The column defaults to the board's first lane, mirroring the promote
 * endpoint's own default of the "To Do" column. The selection defaults and the
 * write payload are built by the shared `promoteTodo` helpers so web + mobile
 * stay in lockstep.
 */

const PRIORITY_OPTIONS = PROMOTE_PRIORITY_OPTIONS;

export default function PromoteTodoModal({
  todo,
  onClose,
  onPromoted,
}: {
  todo: UserTodoWire;
  onClose: () => void;
  onPromoted?: (result: { todo: UserTodoWire; card: unknown }) => void;
}) {
  const [projects, setProjects] = useState<ProjectWire[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [columns, setColumns] = useState<PromoteOption[]>([]);
  const [columnId, setColumnId] = useState<string>('');
  const [epics, setEpics] = useState<PromoteOption[]>([]);
  const [epicId, setEpicId] = useState<string>('');
  const [priority, setPriority] = useState<TodoPriority>(defaultPromotePriority(todo));
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingBoard, setLoadingBoard] = useState(false);
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

  const loadBoard = useCallback((pid: string) => {
    let cancelled = false;
    setLoadingBoard(true);
    setColumns([]);
    setColumnId('');
    setEpics([]);
    setEpicId('');
    api
      .getBoard(pid)
      .then((board: any) => {
        if (cancelled) return;
        const cols = normalizePromoteOptions(board?.columns);
        setColumns(cols);
        // Default to the leftmost / "To Do" lane, matching the promote endpoint.
        setColumnId(defaultPromoteOptionId(cols));
        setEpics(normalizePromoteOptions(board?.epics));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load board');
      })
      .finally(() => {
        if (!cancelled) setLoadingBoard(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    setError(null);
    const cleanup = loadBoard(projectId);
    return cleanup;
  }, [projectId, loadBoard]);

  const canSubmit = canSubmitPromote({ projectId, columnId, submitting, loadingBoard });

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.promoteTodo(
        todo.id,
        buildPromotePayload({ projectId, columnId, priority, epicId }),
      );
      setDone(true);
      onPromoted?.(result);
      window.setTimeout(() => onClose(), 700);
    } catch (err: any) {
      setError(err?.message || 'Failed to promote todo');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="promote-todo-modal"
    >
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Promote to ticket</h3>
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

          <div>
            <label
              htmlFor="promote-project"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Project
            </label>
            <select
              id="promote-project"
              data-testid="promote-project"
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

          <div>
            <label
              htmlFor="promote-column"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Column
            </label>
            <select
              id="promote-column"
              data-testid="promote-column"
              value={columnId}
              onChange={(e) => setColumnId(e.target.value)}
              disabled={loadingBoard || !columns.length}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
            >
              {loadingBoard ? (
                <option value="">Loading columns…</option>
              ) : !columns.length ? (
                <option value="">No columns</option>
              ) : (
                columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <div>
            <label
              htmlFor="promote-priority"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Priority
            </label>
            <select
              id="promote-priority"
              data-testid="promote-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TodoPriority)}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm capitalize text-white focus:border-blue-500 focus:outline-none"
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p} className="capitalize">
                  {p}
                </option>
              ))}
            </select>
          </div>

          {epics.length > 0 && (
            <div>
              <label
                htmlFor="promote-epic"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
              >
                Feature
              </label>
              <select
                id="promote-epic"
                data-testid="promote-epic"
                value={epicId}
                onChange={(e) => setEpicId(e.target.value)}
                disabled={loadingBoard}
                className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
              >
                <option value="">None</option>
                {epics.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
          )}
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
            data-testid="promote-submit"
            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : done ? (
              <Check size={14} />
            ) : null}
            {done ? 'Promoted' : 'Promote'}
          </button>
        </div>
      </div>
    </div>
  );
}
