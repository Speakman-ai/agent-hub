import { useState, useEffect, useRef } from 'react';
import { GitPullRequest, Loader2, ChevronDown, X } from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * ChangesReadyBox
 * ---------------
 * Compact split-button rendered in the chat toolbar (next to the
 * Preview button) when an agent completes work in a worktree with
 * uncommitted changes and no existing kanban card.
 *
 * Left half:  primary "Create ticket & PR" action.
 * Right half: caret toggle that expands a small popover with the
 *             auto-merge switch, dismiss, error, and live publish log.
 *
 * The popover auto-opens while the request is in flight, when a
 * livePrLog stream is active, or when an error needs to be shown.
 *
 * Props:
 *   sessionId         — the session that has pending changes
 *   changes           — { agentId, branch, hasUncommitted, hasUnpushed }
 *   defaultAutoMerge  — initial value for the per-PR auto-merge toggle.
 *                       Comes from `project.githubWorkflow.autoMerge`
 *                       (Layer 1). User can flip locally before creating
 *                       the PR (Layer 2 overrides Layer 1).
 *   livePrLog         — streamed git/gh output for this session
 *   onPublishStart    — (sessionId) => void, optional; called before a
 *                       new commit/push/PR attempt so the parent can
 *                       clear any stale streamed log
 *   onCreated         — (sessionId, { prUrl, cardId }) => void
 *   onDismiss         — (sessionId) => void
 */
export default function ChangesReadyBox({
  sessionId,
  changes,
  livePrLog = '',
  defaultAutoMerge = false,
  onPublishStart,
  onCreated,
  onDismiss,
}) {
  const [autoMerge, setAutoMerge] = useState(!!defaultAutoMerge);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [userOpen, setUserOpen] = useState(false);
  const logEndRef = useRef(null);
  const rootRef = useRef(null);

  // `changes` is optional — the parent now always renders this button while
  // a session is open, even if the server hasn't reported a changes_ready
  // event yet. Fall back to an empty branch label rather than crashing.
  const branchLabel = changes?.branch || '';

  // The popover is forced open while we're talking to the server, while
  // a live log is streaming, or when there's an error to show. Otherwise
  // it follows whatever the user clicked on the caret.
  const forcedOpen = loading || !!livePrLog || !!error;
  const open = forcedOpen || userOpen;

  useEffect(() => {
    if (!livePrLog) return;
    logEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [livePrLog]);

  // Close the popover on outside click (only when not forced open).
  useEffect(() => {
    if (!userOpen || forcedOpen) return;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setUserOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [userOpen, forcedOpen]);

  const handleCreate = async () => {
    if (loading) return;
    onPublishStart?.(sessionId);
    setLoading(true);
    setError(null);
    try {
      const result = await api.createPrFromSession(sessionId, { autoMerge });
      onCreated?.(sessionId, result);
    } catch (err) {
      setError(err.message || 'Failed to create PR');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={rootRef} className="relative inline-flex">
      {/* Split button: primary action + caret toggle */}
      <div className="inline-flex items-stretch rounded-lg overflow-hidden border border-purple-700/60 bg-purple-950/40">
        <button
          type="button"
          onClick={handleCreate}
          disabled={loading}
          title={branchLabel ? `Create ticket & PR for ${branchLabel}` : 'Create ticket & PR'}
          data-testid="create-ticket-pr-button"
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 transition-colors ${
            loading
              ? 'text-gray-400 cursor-not-allowed'
              : 'text-purple-100 hover:bg-purple-900/50 hover:text-white'
          }`}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <GitPullRequest size={14} />}
          {loading ? 'Creating ticket & PR…' : 'Create ticket & PR'}
        </button>
        <button
          type="button"
          onClick={() => setUserOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Toggle auto-merge options"
          data-testid="create-ticket-pr-caret"
          className="inline-flex items-center px-1.5 border-l border-purple-700/60 text-purple-200 hover:bg-purple-900/50 hover:text-white"
        >
          <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Popover */}
      {open && (
        <div
          className="absolute bottom-full left-0 mb-2 z-30 w-80 max-w-[90vw] rounded-xl border border-gray-700/60 bg-gray-900/95 backdrop-blur shadow-xl px-3 py-3 space-y-3"
          data-testid="create-ticket-pr-popover"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-gray-300">
              <GitPullRequest size={14} className="text-purple-400" />
              <span className="font-medium">Changes ready</span>
              {branchLabel && (
                <span className="text-[11px] text-gray-500 truncate max-w-[12rem]">
                  ({branchLabel})
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss?.(sessionId)}
              className="text-gray-500 hover:text-gray-300 p-0.5"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>

          {/* Auto-merge toggle */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <button
                role="switch"
                aria-checked={autoMerge}
                onClick={() => setAutoMerge((v) => !v)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  autoMerge ? 'bg-purple-600' : 'bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                    autoMerge ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
              <span className="text-xs text-gray-300">Auto merge when done</span>
            </label>
          </div>

          <p className="text-[11px] text-gray-500 leading-relaxed">
            {autoMerge
              ? 'A reviewer will review the PR. If approved, it will be merged automatically.'
              : 'A reviewer will review the PR. After approval, a human will merge.'}
          </p>

          {error && (
            <div className="text-xs text-red-400 bg-red-950/30 rounded px-2 py-1 break-words">
              {error}
            </div>
          )}

          {(loading || livePrLog) && (
            <div className="rounded-lg border border-gray-700/80 bg-black/50 overflow-hidden">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-700/60">
                Publish log
              </div>
              <pre
                className="max-h-40 overflow-x-auto overflow-y-auto px-2 py-2 text-[11px] leading-snug font-mono text-gray-200 whitespace-pre-wrap break-words"
                aria-live="polite"
              >
                {livePrLog || (loading ? 'Starting…\n' : '')}
                <span ref={logEndRef} />
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
