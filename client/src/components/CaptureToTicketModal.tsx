import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Loader2, X } from 'lucide-react';
import { api } from '../utils/api';
import type { ProjectWire } from '@shared/types';
import type { CaptureCardDraft } from '@shared/utils/captureCard';

/**
 * Project/column picker for the direct capture path (spec CAPTURE-PROVENANCE):
 * turn a Gmail message / Calendar event into a kanban card on a chosen project
 * board. The `draft` carries the pre-built title / description / provenance
 * triple; this modal only collects the destination (project + column) and an
 * editable title, then POSTs the card with its `source` stamped so the card can
 * be traced back to the message / event it came from.
 */

interface BoardColumn {
  id: string;
  name: string;
}

export default function CaptureToTicketModal({
  draft,
  onClose,
  onCreated,
}: {
  draft: CaptureCardDraft;
  onClose: () => void;
  onCreated?: (result: { projectId: string; card: unknown }) => void;
}) {
  const [projects, setProjects] = useState<ProjectWire[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [columnId, setColumnId] = useState<string>('');
  const [title, setTitle] = useState<string>(draft.title);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);
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

  const loadColumns = useCallback((pid: string) => {
    let cancelled = false;
    setLoadingColumns(true);
    setColumns([]);
    setColumnId('');
    api
      .getBoard(pid)
      .then((board: any) => {
        if (cancelled) return;
        const cols: BoardColumn[] = Array.isArray(board?.columns)
          ? board.columns.map((c: any) => ({ id: String(c.id), name: String(c.name) }))
          : [];
        setColumns(cols);
        // Default to the first column (the board's leftmost / "To Do" lane),
        // mirroring the promote endpoint's default of the To Do column.
        if (cols.length) setColumnId(cols[0].id);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load board columns');
      })
      .finally(() => {
        if (!cancelled) setLoadingColumns(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    setError(null);
    const cleanup = loadColumns(projectId);
    return cleanup;
  }, [projectId, loadColumns]);

  const canSubmit = !!projectId && !!columnId && !!title.trim() && !submitting && !loadingColumns;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const card = await api.createCard(projectId, {
        title: title.trim(),
        ...(draft.description ? { description: draft.description } : {}),
        columnId,
        source: draft.source,
      });
      setCreated(true);
      onCreated?.({ projectId, card });
      window.setTimeout(() => onClose(), 700);
    } catch (err: any) {
      setError(err?.message || 'Failed to create ticket');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Create ticket from capture</h3>
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

          <div>
            <label
              htmlFor="capture-ticket-title"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Title
            </label>
            <input
              id="capture-ticket-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="capture-ticket-project"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Project
            </label>
            <select
              id="capture-ticket-project"
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
              htmlFor="capture-ticket-column"
              className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Column
            </label>
            <select
              id="capture-ticket-column"
              value={columnId}
              onChange={(e) => setColumnId(e.target.value)}
              disabled={loadingColumns || !columns.length}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
            >
              {loadingColumns ? (
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
            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : created ? (
              <Check size={14} />
            ) : null}
            {created ? 'Created' : 'Create ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}
