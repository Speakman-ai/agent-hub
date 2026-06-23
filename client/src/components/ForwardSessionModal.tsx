import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Send, X, ArrowLeftRight } from 'lucide-react';

/**
 * Filter the flat agent list down to the subset that can be forwarded to
 * from a source agent. Rule: same project, active agents only. The source
 * agent is **kept** and pinned at the top of the list so a user can fork
 * the current conversation into a fresh session on the same agent
 * (self-forward is supported end-to-end by the backend). Exported for
 * testing.
 */
export function filterForwardTargets(agents: any, sourceAgent: any) {
  if (!Array.isArray(agents) || !sourceAgent) return [];
  const sourceProjectId = sourceAgent.projectId;
  if (!sourceProjectId) return [];
  const matches = agents.filter(
    (a: any) => a && a.active !== false && a.projectId === sourceProjectId,
  );
  // Pin the source agent at the top so the self-forward option is the
  // first thing the user sees. Order of the rest is preserved.
  const self = matches.find((a: any) => a.id === sourceAgent.id);
  const others = matches.filter((a: any) => a.id !== sourceAgent.id);
  return self ? [self, ...others] : others;
}

export default function ForwardSessionModal({
  sourceAgent,
  agents,
  sessionId,
  onClose,
  onForwarded,
  onForward,
  onError,
}: any) {
  const [selectedAgentId, setSelectedAgentId] = useState<any>(null);
  const [prompt, setPrompt] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<any>(null);
  const [query, setQuery] = useState('');
  const inputRef = useRef<any>(null);

  const candidates = useMemo(
    () => filterForwardTargets(agents, sourceAgent),
    [agents, sourceAgent],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((a: any) => a.name.toLowerCase().includes(q));
  }, [candidates, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: any) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, submitting]);

  const handleSubmit = async (e: any) => {
    e?.preventDefault?.();
    if (!selectedAgentId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onForward({
        targetAgentId: selectedAgentId,
        prompt: prompt.trim() || undefined,
        autoStart,
      });
      if (typeof onForwarded === 'function') onForwarded(result);
      onClose();
    } catch (err: any) {
      const message = err?.message || 'Forward failed';
      setError(message);
      if (typeof onError === 'function') onError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const hasCandidates = candidates.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/60"
      onClick={() => (submitting ? null : onClose())}
      data-testid="forward-modal-backdrop"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e: any) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <ArrowLeftRight size={16} className="text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-100">Forward session</h3>
            {sourceAgent?.name && (
              <span className="text-xs text-gray-500 truncate max-w-[180px]">
                from {sourceAgent.name}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-gray-500 hover:text-gray-200 disabled:opacity-50"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {!hasCandidates ? (
          <div className="p-6 text-sm text-gray-400">
            No agents in this project to forward to. Add an agent in Settings to use this feature.
          </div>
        ) : (
          <>
            <div className="px-4 pt-3">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e: any) => setQuery(e.target.value)}
                placeholder="Filter agents..."
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-600"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[80px]">
              {filtered.length === 0 && (
                <p className="text-sm text-gray-500 px-4 py-3">No agents match.</p>
              )}
              {filtered.map((agent: any) => {
                const isSelf = agent.id === sourceAgent?.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => setSelectedAgentId(agent.id)}
                    className={`w-full text-left px-3 py-2 flex items-center gap-3 rounded-lg transition-colors ${
                      selectedAgentId === agent.id
                        ? 'bg-gray-800 border border-gray-600'
                        : 'border border-transparent hover:bg-gray-800/60'
                    }`}
                  >
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: agent.color }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-200 truncate flex items-center gap-2">
                        <span className="truncate">{agent.name}</span>
                        {isSelf && (
                          <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1 py-0.5 flex-shrink-0">
                            this agent
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {isSelf
                          ? 'Fork this conversation into a new session'
                          : `${agent.engine}${agent.projectName ? ` · ${agent.projectName}` : ''}`}
                      </div>
                    </div>
                    {selectedAgentId === agent.id && (
                      <span className="text-xs text-emerald-400">✓</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="px-4 py-3 border-t border-gray-800 space-y-3">
              <div>
                <label
                  htmlFor="forward-prompt"
                  className="block text-xs font-medium text-gray-400 mb-1"
                >
                  Extra instructions (optional)
                </label>
                <textarea
                  id="forward-prompt"
                  value={prompt}
                  onChange={(e: any) => setPrompt(e.target.value)}
                  rows={2}
                  placeholder="What should the target agent do with this context?"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-600 resize-y"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e: any) => setAutoStart(e.target.checked)}
                  className="rounded border-gray-600 bg-gray-800"
                />
                Auto-start target agent
              </label>
              {error && (
                <p className="text-xs text-red-400" role="alert">
                  {error}
                </p>
              )}
            </div>
          </>
        )}

        <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-xs px-3 py-2 rounded-lg text-gray-400 hover:text-gray-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!selectedAgentId || submitting || !hasCandidates || !sessionId}
            className="text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {submitting ? 'Forwarding...' : 'Forward'}
          </button>
        </div>
      </form>
    </div>
  );
}
