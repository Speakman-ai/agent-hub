import { useState } from 'react';
import { GitPullRequest, X } from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * ChangesReadyBox
 * ---------------
 * Appears after an agent completes work in a worktree with uncommitted changes
 * and no existing kanban card. Prompts the user to create a ticket + PR, with
 * an optional auto-merge toggle.
 *
 * Props:
 *   sessionId  — the session that has pending changes
 *   changes    — { agentId, branch, hasUncommitted, hasUnpushed }
 *   onCreated  — (sessionId, { prUrl, cardId }) => void
 *   onDismiss  — (sessionId) => void
 */
export default function ChangesReadyBox({ sessionId, changes, onCreated, onDismiss }) {
  const [autoMerge, setAutoMerge] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleCreate = async () => {
    if (loading) return;
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
    <div className="flex justify-start mb-4 px-1">
      <div className="max-w-[95%] sm:max-w-[90%] w-full bg-gray-800/80 border border-gray-700/60 rounded-xl px-4 py-3 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-300">
            <GitPullRequest size={16} className="text-purple-400" />
            <span className="font-medium">Changes ready</span>
            <span className="text-xs text-gray-500">({changes.branch})</span>
          </div>
          <button
            onClick={() => onDismiss?.(sessionId)}
            className="text-gray-500 hover:text-gray-300 p-0.5"
            title="Dismiss"
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
            <span className="text-xs text-gray-400">Auto merge when done</span>
          </label>
        </div>

        {/* Description */}
        <p className="text-[11px] text-gray-500 leading-relaxed">
          {autoMerge
            ? 'A reviewer will review the PR. If approved, it will be merged automatically.'
            : 'A reviewer will review the PR. After approval, a human will merge.'}
        </p>

        {/* Error message */}
        {error && (
          <div className="text-xs text-red-400 bg-red-950/30 rounded px-2 py-1">{error}</div>
        )}

        {/* Action button */}
        <button
          onClick={handleCreate}
          disabled={loading}
          className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            loading
              ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
              : 'bg-purple-600 hover:bg-purple-500 text-white'
          }`}
        >
          <GitPullRequest size={14} />
          {loading ? 'Creating ticket & PR...' : 'Create ticket & PR'}
        </button>
      </div>
    </div>
  );
}
