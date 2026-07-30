import { useState, useEffect, useCallback } from 'react';
import { AlertCircle, Loader2, RefreshCw, Square, Trash2 } from 'lucide-react';
import { api } from '../utils/api';

const PREVIEW_STATUS_CLASS = {
  ready: 'text-emerald-400 border-emerald-900/50 bg-emerald-950/30',
  starting: 'text-sky-300 border-sky-900/50 bg-sky-950/30',
  failed: 'text-red-400 border-red-900/50 bg-red-950/30',
} as Record<string, any>;

/**
 * Live list of the project's running session previews, backed by
 * `GET /projects/:id/previews` plus the per-preview stop and purge-all
 * endpoints. Rendered under the dev-server settings because that is the
 * only surface where a project's preview runtime is configured.
 */
export default function RunningPreviewsPanel({ projectId, onOpenSession }: any) {
  const [previews, setPreviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const [purging, setPurging] = useState(false);
  const [stoppingId, setStoppingId] = useState<any>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getProjectPreviews(projectId);
      setPreviews(Array.isArray(res?.previews) ? res.previews : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load running previews');
      setPreviews([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handlePurgeAll = async () => {
    if (!projectId || purging || previews.length === 0) return;
    if (
      !window.confirm(
        `Stop all ${previews.length} running preview(s) for this project? Their dev-server processes are terminated and the ports freed.`,
      )
    ) {
      return;
    }
    setPurging(true);
    setError(null);
    try {
      const res = await api.purgeAllProjectPreviews(projectId);
      if (res?.failed?.length) {
        setError(
          `Stopped ${res.stopped ?? 0}; ${res.failed.length} failed: ${res.failed.map((f: any) => f.error).join('; ')}`,
        );
      }
      await reload();
    } catch (err: any) {
      setError(err?.message || 'Failed to purge previews');
    } finally {
      setPurging(false);
    }
  };

  const handleStopOne = async (previewId: any) => {
    if (!projectId || stoppingId) return;
    setStoppingId(previewId);
    setError(null);
    try {
      await api.stopPreview(projectId, previewId);
      await reload();
    } catch (err: any) {
      setError(err?.message || 'Failed to stop preview');
    } finally {
      setStoppingId(null);
    }
  };

  return (
    <section
      className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3"
      data-testid="preview-running-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-gray-200">Running previews</h4>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading || purging}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
          data-testid="preview-running-refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          type="button"
          onClick={() => void handlePurgeAll()}
          disabled={purging || loading || previews.length === 0}
          className="ml-auto flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-red-900/60 text-red-300 hover:bg-red-950/40 disabled:opacity-50"
          data-testid="preview-purge-all-button"
        >
          {purging ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          Purge all
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Session previews started from chat. Purge stops every one of them and frees their ports.
      </p>
      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1">
          <AlertCircle size={12} /> {error}
        </p>
      )}
      {loading && previews.length === 0 && (
        <p className="text-xs text-gray-500 flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </p>
      )}
      {!loading && previews.length === 0 && (
        <p className="text-xs text-gray-500" data-testid="preview-running-empty">
          No running previews for this project.
        </p>
      )}
      {previews.length > 0 && (
        <ul className="space-y-2">
          {previews.map((p: any) => {
            const statusClass = PREVIEW_STATUS_CLASS[p.status] ?? PREVIEW_STATUS_CLASS.starting;
            return (
              <li
                key={p.id}
                className="rounded border border-gray-800/80 bg-gray-950/40 px-3 py-2 flex flex-wrap items-start gap-2"
                data-testid={`preview-running-row-${p.id}`}
              >
                <span
                  className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border shrink-0 ${statusClass}`}
                >
                  {p.status}
                </span>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <p className="text-sm text-gray-200 truncate">{p.sessionName || p.sessionId}</p>
                  <p className="text-[11px] text-gray-500 font-mono truncate">
                    {p.id}
                    {typeof p.port === 'number' ? ` · port ${p.port}` : ''}
                    {p.url ? ` · ${p.url}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {typeof onOpenSession === 'function' && p.sessionId && (
                    <button
                      type="button"
                      onClick={() => onOpenSession({ sessionId: p.sessionId, agentId: p.agentId })}
                      className="text-xs text-sky-400 hover:text-sky-300 px-2 py-1 rounded border border-gray-700"
                    >
                      Open session
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleStopOne(p.id)}
                    disabled={stoppingId === p.id || purging}
                    className="flex items-center gap-1 text-xs text-gray-300 hover:text-white px-2 py-1 rounded border border-gray-700 disabled:opacity-50"
                    data-testid={`preview-stop-${p.id}`}
                  >
                    {stoppingId === p.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Square size={12} />
                    )}
                    Stop
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
