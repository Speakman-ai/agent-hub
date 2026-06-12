/**
 * GitHostMirrorStatusBanner — surfaces the GitHub mirror sync state for a
 * Hub-hosted project and offers an on-demand "Reconcile" action.
 *
 * Renders nothing when the mirror is healthy (synced / transiently ahead).
 * Shows a warning when GitHub is ahead (commits landed directly on GitHub
 * that haven't been pulled in yet) and an error when the branches have
 * diverged or a push is being rejected. Reconcile triggers
 * POST /git-host/mirror/reconcile, which fast-forwards / merges / pushes
 * as appropriate.
 *
 * It refreshes on mount, after a manual reconcile, and whenever the server
 * broadcasts a `git_host_mirror` event for this project (bridged from the
 * WebSocket to a window CustomEvent in App.jsx) — so a background
 * reconcile-poller change (pulled / diverged / push error) becomes visible
 * without reloading the page.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, GitMerge, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../utils/api.js';
import { describeMirrorState } from '../utils/mirrorStatus.js';

const SEVERITY_STYLES = {
  error: 'bg-red-500/10 border-red-500/30 text-red-200',
  warn: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
};

export default function GitHostMirrorStatusBanner({ projectId, onToast }) {
  const [mirror, setMirror] = useState(null);
  const [reconciling, setReconciling] = useState(false);

  const load = useCallback(async () => {
    try {
      setMirror(await api.getGitHostMirror(projectId));
    } catch {
      // Non-hosted projects 404 here — just stay hidden.
      setMirror(null);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh when the server broadcasts a mirror event for this project.
  useEffect(() => {
    const onMirrorEvent = (e) => {
      if (e?.detail?.projectId === projectId) load();
    };
    window.addEventListener('git_host_mirror', onMirrorEvent);
    return () => window.removeEventListener('git_host_mirror', onMirrorEvent);
  }, [projectId, load]);

  const reconcile = async () => {
    setReconciling(true);
    try {
      const result = await api.reconcileGitHostMirror(projectId);
      setMirror((prev) => ({ ...(prev || {}), state: result.state }));
      if (onToast) {
        const msg =
          result.action === 'diverged'
            ? 'Branches still diverged — resolve the conflict manually.'
            : result.action === 'error'
              ? 'Reconcile failed — see mirror status.'
              : `Mirror reconciled (${result.action}).`;
        onToast(
          msg,
          result.action === 'diverged' || result.action === 'error' ? 'error' : 'success',
        );
      }
    } catch (err) {
      if (onToast) onToast(String(err?.message || err), 'error');
    } finally {
      setReconciling(false);
    }
  };

  const desc = describeMirrorState(mirror);
  if (!desc) return null;

  return (
    <div
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
        SEVERITY_STYLES[desc.severity] || SEVERITY_STYLES.warn
      }`}
      data-testid="mirror-status-banner"
    >
      <AlertTriangle size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{desc.title}</div>
        <div className="text-sm opacity-90 break-words">{desc.detail}</div>
      </div>
      {desc.showReconcile && (
        <button
          type="button"
          onClick={reconcile}
          disabled={reconciling}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-current/40 px-3 py-1.5 text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
          data-testid="mirror-reconcile"
        >
          {reconciling ? (
            <Loader2 size={14} className="animate-spin" />
          ) : desc.severity === 'error' ? (
            <GitMerge size={14} />
          ) : (
            <RefreshCw size={14} />
          )}
          {reconciling ? 'Reconciling…' : 'Reconcile'}
        </button>
      )}
    </div>
  );
}
