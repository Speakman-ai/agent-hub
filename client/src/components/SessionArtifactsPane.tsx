import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  RefreshCw,
  Download,
  ExternalLink,
  Trash2,
  Loader2,
  AlertCircle,
  Package,
} from 'lucide-react';
import { api } from '../utils/api';
import { viewArtifact, downloadArtifact } from '../utils/artifactContent';
import { formatBytes, isInlineViewable, artifactGlyph } from '@shared/utils/artifactView';
import { formatDateTime } from '../utils/time';

/**
 * SessionArtifactsPane
 *
 * Lists the documents an agent generated during a session (PDFs, scripts,
 * reports, …) and lets the user view or download them. Mirrors the right-pane
 * chrome of SessionChangesPane and is mutually exclusive with it / the preview
 * pane (the parent renders only one right pane at a time).
 *
 * Data flow:
 *   GET    /api/sessions/:id/artifacts                       → metadata list
 *   GET    /api/sessions/:id/artifacts/:aid/content          → bytes (view/download)
 *   DELETE /api/sessions/:id/artifacts/:aid                  → remove
 *
 * `reloadToken` is bumped by the parent on every `artifact_created` /
 * `artifact_deleted` WS event for this session so the list stays live.
 */
export default function SessionArtifactsPane({
  sessionId,
  reloadToken = 0,
  onClose,
  onCount,
}: any) {
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  // Hold the latest onCount in a ref so the load callback doesn't depend on the
  // parent's (inline) callback identity and refire endlessly.
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;

  // Stale-response guard: discard a resolved fetch if the session changed or a
  // newer load started while it was in flight.
  const loadSeqRef = useRef(0);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const loadArtifacts = useCallback(async () => {
    if (!sessionId) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await api.getSessionArtifacts(sessionId);
      if (seq !== loadSeqRef.current || sessionRef.current !== sessionId) return;
      const list = Array.isArray(res?.artifacts) ? res.artifacts : [];
      setArtifacts(list);
      onCountRef.current?.(list.length);
    } catch (err: any) {
      if (seq !== loadSeqRef.current || sessionRef.current !== sessionId) return;
      setError(err?.message || 'Failed to load artifacts');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadArtifacts();
  }, [loadArtifacts, reloadToken]);

  const handleView = useCallback(
    async (artifact: any) => {
      setBusyId(artifact.id);
      try {
        await viewArtifact(sessionId, artifact.id);
      } catch (err: any) {
        setError(err?.message || 'Failed to open artifact');
      } finally {
        setBusyId('');
      }
    },
    [sessionId],
  );

  const handleDownload = useCallback(
    async (artifact: any) => {
      setBusyId(artifact.id);
      try {
        await downloadArtifact(sessionId, artifact.id, artifact.filename);
      } catch (err: any) {
        setError(err?.message || 'Failed to download artifact');
      } finally {
        setBusyId('');
      }
    },
    [sessionId],
  );

  const handleDelete = useCallback(
    async (artifact: any) => {
      if (!window.confirm(`Delete artifact "${artifact.filename}"?`)) return;
      setBusyId(artifact.id);
      try {
        await api.deleteSessionArtifact(sessionId, artifact.id);
        setArtifacts((prev: any) => {
          const next = prev.filter((a: any) => a.id !== artifact.id);
          onCountRef.current?.(next.length);
          return next;
        });
      } catch (err: any) {
        setError(err?.message || 'Failed to delete artifact');
      } finally {
        setBusyId('');
      }
    },
    [sessionId],
  );

  return (
    <aside
      data-testid="session-artifacts-pane"
      className="hidden lg:flex flex-col shrink-0 border-l border-gray-800 bg-gray-950 relative w-[420px]"
      aria-label="Session artifacts"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900/60">
        <Package size={14} className="text-violet-300 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-gray-100 truncate">
            Artifacts
            {artifacts.length > 0 && (
              <span className="ml-1 text-gray-400 font-normal">
                · {artifacts.length} file{artifacts.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <div className="text-[10px] text-gray-500 truncate">Documents generated this session</div>
        </div>
        <button
          type="button"
          onClick={loadArtifacts}
          title="Refresh artifacts"
          aria-label="Refresh artifacts"
          data-testid="session-artifacts-pane-refresh"
          className="text-gray-400 hover:text-gray-100"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close pane"
          aria-label="Close artifacts pane"
          data-testid="session-artifacts-pane-close"
          className="text-gray-400 hover:text-gray-100 ml-0.5"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && (
          <div
            className="flex items-center gap-2 px-3 py-2 text-xs text-red-200 bg-red-950/40 border-b border-red-900/50"
            data-testid="session-artifacts-pane-error"
          >
            <AlertCircle size={14} className="shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {loading && artifacts.length === 0 && (
          <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-gray-400">
            <Loader2 size={16} className="animate-spin" />
            Loading artifacts…
          </div>
        )}

        {!loading && artifacts.length === 0 && !error && (
          <div
            className="px-4 py-10 text-center text-xs text-gray-500"
            data-testid="session-artifacts-pane-empty"
          >
            <Package size={28} className="mx-auto mb-2 text-gray-700" />
            No artifacts yet.
            <div className="mt-1 text-gray-600">
              When the agent generates a document (PDF, script, report…), it appears here.
            </div>
          </div>
        )}

        <ul className="divide-y divide-gray-800/70">
          {artifacts.map((artifact: any) => {
            const canView = isInlineViewable(artifact.contentType, artifact.filename);
            const isBusy = busyId === artifact.id;
            return (
              <li
                key={artifact.id}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-900/40"
                data-testid="session-artifacts-pane-item"
              >
                <span className="text-lg shrink-0" aria-hidden>
                  {artifactGlyph(artifact.contentType, artifact.filename)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-100 truncate" title={artifact.filename}>
                    {artifact.filename}
                  </div>
                  <div className="text-[10px] text-gray-500 truncate">
                    {formatBytes(artifact.size)}
                    {artifact.createdAt ? ` · ${formatDateTime(artifact.createdAt)}` : ''}
                    {artifact.createdBy ? ` · ${artifact.createdBy}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isBusy && <Loader2 size={13} className="animate-spin text-gray-400" />}
                  {canView && (
                    <button
                      type="button"
                      onClick={() => handleView(artifact)}
                      disabled={isBusy}
                      title="View"
                      aria-label={`View ${artifact.filename}`}
                      data-testid="session-artifacts-pane-view"
                      className="text-gray-400 hover:text-violet-300 disabled:opacity-50"
                    >
                      <ExternalLink size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDownload(artifact)}
                    disabled={isBusy}
                    title="Download"
                    aria-label={`Download ${artifact.filename}`}
                    data-testid="session-artifacts-pane-download"
                    className="text-gray-400 hover:text-violet-300 disabled:opacity-50"
                  >
                    <Download size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(artifact)}
                    disabled={isBusy}
                    title="Delete"
                    aria-label={`Delete ${artifact.filename}`}
                    data-testid="session-artifacts-pane-delete"
                    className="text-gray-400 hover:text-red-400 disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
